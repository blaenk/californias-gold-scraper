/* eslint-disable no-console */

require('dotenv').config();

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const rootCas = require('ssl-root-cas/latest').create();
require('https').globalAgent.options.ca = rootCas;

const minimist = require('minimist');

const request = require('request');
const promisedRequest = require('request-promise-native');

const FeedParser = require('feedparser');
const cheerio = require('cheerio');

const humanize = require('humanize-plus');
const sanitize = require("sanitize-filename");
const FuzzySet = require('fuzzyset.js');

const shellEscape = require('shell-escape');

const TVDB = require('node-tvdb');
const tvdb = new TVDB(process.env.TVDB_KEY);

let CACHE = {
  tvdb: {},
  pages: {},
};

const SHOWS = {
  'alaska-week': {
    name: 'Alaska Week',
  },
  'california-missions': {
    name: 'California Missions',
  },
  'californias-communities': {
    name: "California's Communities",
  },
  'californias-gold': {
    name: "California's Gold",
    tvdb_id: 279999,
  },
  'californias-golden-coast': {
    name: "California's Golden Coast",
    tvdb_id: 282164,
  },
  'californias-golden-fairs': {
    name: "California's Golden Fairs",
    tvdb_id: 281267,
  },
  'californias-golden-parks': {
    name: "California's Golden Parks",
    tvdb_id: 282166,
  },
  'californias-green': {
    name: "California's Green",
  },
  'californias-water': {
    name: "California's Water",
  },
  'crossroads': {
    name: 'Crossroads',
  },
  'downtown': {
    name: 'Downtown',
  },
  'our-neighborhoods': {
    name: 'Our Neighborhoods',
  },
  'palm-springs-week': {
    name: 'Palm Springs Week',
  },
  'road-trip': {
    name: 'Road Trip',
  },
  'specials': {
    name: 'Specials',
  },
  'the-bench': {
    name: 'The Bench',
  },
  'visiting': {
    name: 'Visiting',
  },
};

const cacheContents = fs.readFileSync('cache.json');

if (cacheContents != '') {
  CACHE = JSON.parse(cacheContents);
}

function categoryFeedUrl(showName) {
  return `https://blogs.chapman.edu/huell-howser-archives/category/${showName}/feed/atom/`;
}

function feedPageUrl(feedUrl, pageNumber) {
  return `${feedUrl}?paged=${pageNumber}`;
}

function createFeedUrlForShow(showName) {
  SHOWS[showName].feedUrl = categoryFeedUrl(showName);
}

for (const show of Object.keys(SHOWS)) {
  createFeedUrlForShow(show);
}

/**
 * Get the URL's file size.
 * @param {String} url - The url.
 * @returns {Number} The file size.
 */
async function getFileSize(url) {
  const response = await promisedRequest({
    method: 'HEAD',
    url,
    resolveWithFullResponse: true,
    strictSSL: false,
  });

  if (!('content-length' in response.headers)) {
    return 0;
  }

  const length = response.headers['content-length'];

  return parseInt(length);
}

/**
 * Parse the JW Player config.
 * @param {String} content - The script content.
 * @returns {Object} The config object.
 */
function getJWConfig(content) {
  const configRegex = /var jwConfig = ({[\s\S]*}); \/\/ end config/m;
  const configMatch = content.match(configRegex);

  return JSON.parse(configMatch[1]);
}

/**
 * Crawl video URLs from JW Player.
 * @param {String} title - Page title.
 * @param {String} pageUrl - Page URL.
 * @param {String} sourceUrl - JW Player script URL.
 * @returns {Object} The page object.
 * @throws {String} If no playlist is found.
 */
async function getVideosFromJWPlayer(title, pageUrl, sourceUrl) {
  const response = await promisedRequest(sourceUrl);
  const config = getJWConfig(response);

  if (!('playlist' in config)) {
    throw 'No playlist found!';
  }

  if (!config.playlist) {
    throw 'Playlist empty!';
  }

  const playlist = config.playlist[0];

  const page = {
    pageUrl,
    sourceUrl,
    title,
    videos: {},
  };

  // Order highest-quality first.
  playlist.sources.reverse();

  for (const source of playlist.sources) {
    if (source.type === 'hls') {
      continue;
    }

    const video = {
      src: 'https:' + source.file,
      label: source.width === 720 ? 'HD' : 'SD',
    };

    video.size = await getFileSize(video.src);

    if (source.width === 720) {
      page.videos.HD = video;
    } else if (source.width === 480) {
      page.videos.SD = video;
      break;
    }
  }

  return page;
}

/**
 * Get videos of particular quality.
 * @param {Object[]} videoAttributes - Video attributes array.
 * @param {String} sourceUrl - The iframe page URL.
 * @param {Object} page - The page.
 * @param {String} quality - The quality. 'SD' or 'HD'.
 * @throws {String} If more than one of that quality is found.
 */
async function getIframeVideosOfQuality(videoAttributes, sourceUrl, page, quality) {
  const videosOfQuality = videoAttributes.filter((v) => v.label === quality);

  if (videosOfQuality.length > 1) {
    throw 'More than one ' + quality + ' video found: ' + sourceUrl;
  }

  if (videosOfQuality.length === 1) {
    page.videos[quality] = videosOfQuality[0];

    page.videos[quality].size = await getFileSize(page.videos[quality].src);
  }
}

/**
 * Get videos from the given iframe page.
 * @param {String} title - The page title.
 * @param {String} pageUrl - The page URL.
 * @param {String} sourceUrl - The iframe page URL.
 * @returns {Object} The page object.
 */
async function getVideosFromIframe(title, pageUrl, sourceUrl) {
  const response = await promisedRequest.get({
    url: sourceUrl,
    rejectUnauthorized: false,
    agentOptions: {
      ca: rootCas,
    }
  });

  const $ = cheerio.load(response);

  const videoAttributes = $('video > source').map((_index, element) => {
    return {
      src: element.attribs.src,
      label: element.attribs.label,
    };
  }).get();

  let subtitles = $('video > track').map((_index, element) => element.attribs.src).get();

  const page = {
    pageUrl,
    sourceUrl,
    title,
    videos: {},
  };

  if (subtitles) {
    page.subtitles = subtitles[0];
  }

  await getIframeVideosOfQuality(videoAttributes, sourceUrl, page, 'SD');
  await getIframeVideosOfQuality(videoAttributes, sourceUrl, page, 'HD');

  return page;
}

/**
 * Find videos on the page.
 * @param {String} pageUrl - The page URL.
 * @returns {Object} The page Object.
 * @throws {String} If selectors find nothing.
 */
async function getPageVideos(pageUrl) {
  if (pageUrl in CACHE.pages) {
    return CACHE.pages[pageUrl];
  }

  const response = await promisedRequest(pageUrl);
  const $ = cheerio.load(response);

  const title = $('article > div.post_content > h1 > a').first().text();

  const $iframes = $('iframe[src^="https://vhost"]');

  if ($iframes.length === 1) {
    const iframeUrl = $iframes.first().attr('src');

    const page = await getVideosFromIframe(title, pageUrl, iframeUrl);

    CACHE.pages[pageUrl] = page;

    return page;
  } else if ($iframes.length > 1) {
    throw `Found more than one matching iframe: ${pageUrl}`;
  } else {
    const $jwVideo = $('script[src^="//content.jwplatform.com/players/"]');

    if ($jwVideo.length === 1) {
      const jwPlayerUrl = 'https:' + $jwVideo.first().attr('src');

      const page = await getVideosFromJWPlayer(title, pageUrl, jwPlayerUrl);

      CACHE.pages[pageUrl] = page;

      return page;
    } else if ($jwVideo.length > 1) {
      throw "Found more than one JW Player <video> tag! " + pageUrl;
    } else {
      throw "Couldn't find a JW Player <video> tag! " + pageUrl;
    }
  }
}

async function getTVDBEpisodes(seasonId) {
  if (CACHE.tvdb[seasonId]) {
    return CACHE.tvdb[seasonId];
  } else {
    const response = await tvdb.getEpisodesBySeriesId(seasonId);

    CACHE.tvdb[seasonId] = response;

    return response;
  }
}

function episodePadding(number) {
  return (number < 10) ? ('0' + number) : number;
}

async function renameEpisode(page) {
  const showName = SHOWS[page.show].name;

  const outputPath = 'videos/' + page.show + '/';
  const normalizedQuotes = page.title.replace(/’/g, "'");
  const showNamePattern = new RegExp(" ?[-–—] ?" + showName + '( \\(\\d+\\))?');
  let episodeName = normalizedQuotes.replace(showNamePattern, '');

  const show = showName.replace(/ /g, '.');

  let episodeNumber = '.';

  if (SHOWS[page.show].tvdb_id) {
    let episodes = await getTVDBEpisodes(SHOWS[page.show].tvdb_id);

    episodes = episodes.filter((e) => e.episodeName);

    if (!SHOWS[page.show].fuzzyset) {
      const episodeNames = episodes.map((e) => e.episodeName);

      SHOWS[page.show].fuzzyset = FuzzySet(episodeNames);
    }

    const fuzzyMatch = SHOWS[page.show].fuzzyset.get(episodeName);

    if (fuzzyMatch) {
      const firstMatch = fuzzyMatch[0];

      let match;

      if (firstMatch[0] < 0.7) {
        // Low confidence; attempt simple prefix match.
        console.log('Low confidence for ' + episodeName);

        match = episodes.find((e) => e.episodeName.startsWith(episodeName));
      } else {
        const matchName = firstMatch[1];
        match = episodes.find((e) => e.episodeName == matchName);
      }

      if (match) {
        console.log(`Matched: ${episodeName} → ${match.episodeName}`);

        episodeName = match.episodeName;

        const season = episodePadding(match.airedSeason);
        const episode = episodePadding(match.airedEpisodeNumber);

        episodeNumber = `.S${season}E${episode}.`;
      } else {
        console.log("Couldn't find a matching episode for " + episodeName);
      }
    } else {
      console.log("Couldn't find a matching episode for " + episodeName);
    }
  }

  episodeName = episodeName.replace(/ /g, '.').replace(/'/g, '').replace(/&/g, 'and');

  const fileName = sanitize(show.replace(/'/g, '') + episodeNumber + episodeName);

  const joined = outputPath + fileName + '.mp4';

  return joined;
}

/**
 * Format the appropriate wget parameters.
 * @param {Object} page - The page object.
 * @returns {String[]} The wget parameters.
 */
// eslint-disable-next-line no-unused-vars
function formatWgetParameters(page) {
  const quality = 'HD' in page.videos ? 'HD' : 'SD';
  const video = page.videos[quality];

  return [video.src, '--no-check-certificate', '-nc', '-O', page.renamed];
}

function formatCurlParameters(page) {
  const quality = 'HD' in page.videos ? 'HD' : 'SD';
  const video = page.videos[quality];

  return [video.src, '--create-dirs', '-k', '-o', page.renamed];
}

/**
 * Invoke wget to download the highest-quality video from the given page object.
 * @param {Object} page - The page object.
 */
function downloadVideos(page) {
  const args = formatCurlParameters(page);

  const fileName = args[args.length - 1];

  if (fs.existsSync(fileName)) {
    console.log(fileName + ' already existed. Skipping.');
    return;
  }

  console.log('curl ' + args.join(' '));

  child_process.spawnSync('curl', args, {
    stdio: 'inherit',
  });
}

/**
 * Collect all post links from feed.
 * @param {String} showName - The show name.
 * @param {Number} pageNumber - The page number.
 * @returns {String[]} The post links.
 */
function getFeedPageLinks(showName, pageNumber) {
  const links = [];

  const url = feedPageUrl(SHOWS[showName].feedUrl, pageNumber);

  return new Promise((resolve, reject) => {
    request(url)
      .pipe(new FeedParser)
      .on('error', reject)
      .on('meta', (meta) => {
        if (meta.title.startsWith('Page not found')) {
          reject('Page not found');
          return;
        }
      })
      .on('readable', function() {
        const stream = this;

        let item = stream.read();

        while (item) {
          links.push(item.link);

          item = stream.read();
        }
      })
      .on('end', function() {
        resolve(links);
      });
  });
}

/**
 * Find all videos of the given show.
 * @param {String} showName - The show name.
 * @returns {void}
 */
async function crawlCategory(showName) {
  let pageNumber = 1;
  let totalSize = 0;
  const videos = [];

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log(`Page ${pageNumber}`);

      const links = await getFeedPageLinks(showName, pageNumber);

      for (const link of links) {
        let page;

        page = await getPageVideos(link);
        page.show = showName;

        const quality = 'HD' in page.videos ? 'HD' : 'SD';

        page.renamed = await renameEpisode(page);

        console.log(`Adding ${page.renamed}: ${humanize.fileSize(page.videos[quality].size)}`);
        totalSize += page.videos[quality].size;

        videos.push(page);
      }

      pageNumber++;
    }
  } catch(e) {
    if (e === 'Page not found') {
      console.log('Reached the end of the feed.');
    } else {
      console.error(e);
    }
  }

  fs.writeFileSync('cache.json', JSON.stringify(CACHE));

  console.log(`Total size: ${humanize.fileSize(totalSize)}`);

  videos.sort((a, b) => a.renamed.localeCompare(b.renamed));

  const commands = ['set -e'];

  for (const [index, page] of videos.entries()) {
    commands.push(`echo "[${index + 1}/${videos.length}]: ${path.basename(page.renamed)}"`);

    if (page.subtitles) {
      const quality = 'HD' in page.videos ? 'HD' : 'SD';
      const video = page.videos[quality];

      const ffmpegArguments = [
        '-hide_banner',
        '-n',
        '-i', video.src,
        '-fix_sub_duration',
        '-i', page.subtitles,
        '-map', '0:v',
        '-map', '0:a',
        '-c', 'copy',
        '-map', '1',
        '-c:s:0', 'mov_text',
        '-metadata:s:s:0', 'language=eng',
        '-disposition:s:0', 'default',
        '-metadata:s:v:0', 'handler=English',
        '-metadata:s:a:0', 'handler=English',
        '-metadata:s:s:0', 'handler=English',
        page.renamed,
      ];

      commands.push('ffmpeg ' + shellEscape(ffmpegArguments));
    } else {
      commands.push('curl ' + shellEscape(formatCurlParameters(page)));
    }
  }

  fs.writeFileSync(`download-${showName}.sh`, commands.join("\n"));
}

const params = minimist(process.argv.slice(2));

if ('show' in params) {
  const showName = params.show;

  (async function() {
    await crawlCategory(showName);
  })();

} else if ('single' in params) {
  const url = params.single;

  (async function() {
    const page = await getPageVideos(url);

    fs.writeFileSync('cache.json', JSON.stringify(CACHE));

    await downloadVideos(page);
  })();
} else {
  console.log('Pass either --show SHOW-NAME or --single URL');
}
