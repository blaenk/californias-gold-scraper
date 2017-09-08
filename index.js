/* eslint-disable no-console */

const child_process = require('child_process');
const fs = require('fs');

const rootCas = require('ssl-root-cas/latest').create();
require('https').globalAgent.options.ca = rootCas;

const minimist = require('minimist');

const request = require('request');
const promisedRequest = require('request-promise-native');

const FeedParser = require('feedparser');
const cheerio = require('cheerio');

const humanize = require('humanize-plus');
const sanitize = require("sanitize-filename");

let CACHE = {};

const SHOWS = [
  'alaska-week',
  'california-missions',
  'californias-communities',
  'californias-gold',
  'californias-golden-coast',
  'californias-golden-fairs',
  'californias-golden-parks',
  'californias-green',
  'californias-water',
  'crossroads',
  'downtown',
  'our-neighborhoods',
  'palm-springs-week',
  'road-trip',
  'specials',
  'the-bench',
  'visiting',
];

const SHOW_FEED_URLS = {};

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
  SHOW_FEED_URLS[showName] = categoryFeedUrl(showName);
}

for (const show of SHOWS) {
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

  const page = {
    pageUrl,
    sourceUrl,
    title,
    videos: {},
  };

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
  if (pageUrl in CACHE) {
    return CACHE[pageUrl];
  }

  const response = await promisedRequest(pageUrl);
  const $ = cheerio.load(response);

  const title = $('article > div.post_content > h1 > a').first().text();

  const $iframes = $('iframe[src^="https://vhost"]');

  if ($iframes.length === 1) {
    const iframeUrl = $iframes.first().attr('src');

    const page = await getVideosFromIframe(title, pageUrl, iframeUrl);

    CACHE[pageUrl] = page;

    return page;
  } else if ($iframes.length > 1) {
    throw `Found more than one matching iframe: ${pageUrl}`;
  } else {
    const $jwVideo = $('script[src^="//content.jwplatform.com/players/"]');

    if ($jwVideo.length === 1) {
      const jwPlayerUrl = 'https:' + $jwVideo.first().attr('src');

      const page = await getVideosFromJWPlayer(title, pageUrl, jwPlayerUrl);

      CACHE[pageUrl] = page;

      return page;
    } else if ($jwVideo.length > 1) {
      throw "Found more than one JW Player <video> tag! " + pageUrl;
    } else {
      throw "Couldn't find a JW Player <video> tag! " + pageUrl;
    }
  }
}

/**
 * Format the appropriate wget parameters.
 * @param {Object} page - The page object.
 * @returns {String[]} The wget parameters.
 */
function formatWgetParameters(page) {
  const quality = 'HD' in page.videos ? 'HD' : 'SD';
  const video = page.videos[quality];

  const bareName = page.title.replace(/ ?[-–—] ?California’s Gold/, " - California's Gold");
  const title = bareName.replace(/’/, "'");
  const sanitized = sanitize(title);

  const fileName = `videos/${sanitized}.mp4`;

  return [video.src, '--no-check-certificate', '-nc', '-O', fileName];
}

/**
 * Invoke wget to download the highest-quality video from the given page object.
 * @param {Object} page - The page object.
 */
// eslint-disable-next-line no-unused-vars
function downloadVideos(page) {
  const args = formatWgetParameters(page);

  const fileName = args[args.length - 1];

  if (fs.existsSync(fileName)) {
    console.log(fileName + ' already existed. Skipping.');
    return;
  }

  console.log('wget ' + args.join(' '));

  child_process.spawnSync('wget', args, {
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

  const url = feedPageUrl(SHOW_FEED_URLS[showName], pageNumber);

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

        const quality = 'HD' in page.videos ? 'HD' : 'SD';

        console.log(`Adding ${page.title}: ${humanize.fileSize(page.videos[quality].size)}`);
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

  console.log(`Total size: ${humanize.fileSize(totalSize)}`);

  // Sort videos by episode number.
  videos.sort((a, b) => {
    const aMatch = a.title.match(/\((\d+\))$/);
    const bMatch = b.title.match(/\((\d+\))$/);

    // If an episode doesn't have an episode number, make it come before.
    if (!aMatch) {
      return -1;
    }

    if (!bMatch) {
      return 1;
    }

    const aNumber = parseInt(aMatch[1]);
    const bNumber = parseInt(bMatch[1]);

    return aNumber - bNumber;
  });

  const commands = videos.map((page) => 'wget ' + formatWgetParameters(page).join(' '));

  fs.writeFileSync(`download-${showName}.sh`, commands.join("\n"));
}

const params = minimist(process.argv.slice(2));

if ('show' in params) {
  const showName = params.show;

  (async function() {
    await crawlCategory(showName);

    fs.writeFileSync('cache.json', JSON.stringify(CACHE));
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
