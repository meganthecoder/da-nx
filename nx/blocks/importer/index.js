import { DA_ORIGIN } from '../../public/utils/constants.js';
import { replaceHtml, daFetch } from '../../utils/daFetch.js';
import { mdToDocDom, docDomToAemHtml } from '../../utils/converters.js';
import { Queue } from '../../public/utils/tree.js';

const parser = new DOMParser();
const FRAGMENT_SELECTOR = 'a[href*="/fragments/"]';
const EXTS = ['json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'pdf'];

let localUrls;

async function findFragments(pageUrl, text) {
  const dom = parser.parseFromString(text, 'text/html');
  const results = dom.body.querySelectorAll(FRAGMENT_SELECTOR);
  const fragments = [...results].reduce((acc, a) => {
    const href = a.getAttribute('href');

    // Don't add any off-origin fragments
    // if (!href.startsWith(pageUrl.origin)) return acc;
    const fromOriginSegment = `https://main--${pageUrl.fromRepo}--${pageUrl.fromOrg}.`;
    if (!href.startsWith(fromOriginSegment)) return acc;

    // Convert relative to current project origin
    const url = new URL(href);

    // Check if its already in our URL list
    const found = localUrls.some((existing) => existing.pathname === url.pathname);
    if (found) return acc;

    // Mine the page URL for where to send the fragment
    const { toOrg, toRepo } = pageUrl;

    url.toOrg = toOrg;
    url.toRepo = toRepo;

    acc.push(url);
    return acc;
  }, []);

  localUrls.push(...fragments);
}

export function calculateTime(startTime) {
  const totalTime = Date.now() - startTime;
  return `${String((totalTime / 1000) / 60).substring(0, 4)}`;
}

export async function getAemHtml(url, text) {
  const dom = mdToDocDom(text);
  const aemHtml = docDomToAemHtml(dom);
  return aemHtml;
}

function replaceLinks(html, fromOrg, fromRepo) {
  return html;
}

function getLinkedAssets(pageUrl, html) {
  const dom = parser.parseFromString(html, 'text/html');
  const assets = [];
  // Links
  const results = dom.body.querySelectorAll('a');
  const fromOriginSegment = `https://main--${pageUrl.fromRepo}--${pageUrl.fromOrg}.`;
  const assetsFromAnchors = [...results].reduce((acc, a) => {
    const href = a.getAttribute('href');
    if (!href.startsWith(fromOriginSegment) || !EXTS.some((ext) => href.includes(`.${ext}`))) return acc;

    const url = new URL(href);
    const { toOrg, toRepo } = pageUrl;
    url.toOrg = toOrg;
    url.toRepo = toRepo;
    acc.push(url);

    return acc;
  }, []);
  assets.push(...assetsFromAnchors);
  // Image alt text
  const images = dom.body.querySelectorAll('img[alt*="|"]');
  const assetsFromAlt = [...images].reduce((acc, img) => {
    const [href, alt, icon] = img.alt.split('|');
    href.trim();
    // RE exts - does this really apply to anything other than mp4?
    if (!href.startsWith(fromOriginSegment) || !EXTS.some((ext) => href.includes(`.${ext}`))) return acc;

    const url = new URL(href);
    const { toOrg, toRepo } = pageUrl;
    url.toOrg = toOrg;
    url.toRepo = toRepo;
    acc.push(url);

    return acc;
  }, []);
  assets.push(...assetsFromAlt);

  console.log(assets);
  localUrls.push(...assets);
  return assets;
}

async function saveAllToDa(url, blob) {
  const { toOrg, toRepo, destPath, editPath, route } = url;

  url.daHref = `https://da.live${route}#/${toOrg}/${toRepo}${editPath}`;

  const body = new FormData();
  body.append('data', blob);
  const opts = { method: 'PUT', body };

  try {
    // TESTING ONLY - save to drafts
    const resp = await daFetch(`${DA_ORIGIN}/source/${toOrg}/${toRepo}/drafts/methomas/import-test${destPath}`, opts);
    console.log(resp);
    return resp.status;
  } catch {
    console.log(`Couldn't save ${destPath}`);
    return 500;
  }
}

async function importUrl(url, findFragmentsFlag, setProcessed) {
  const [fromRepo, fromOrg] = url.hostname.split('.')[0].split('--').slice(1).slice(-2);
  if (!(fromRepo || fromOrg)) {
    url.status = '403';
    url.error = 'URL is not from AEM.';
    return;
  }

  url.fromRepo ??= fromRepo;
  url.fromOrg ??= fromOrg;

  const { pathname, href } = url;
  if (href.endsWith('.xml') || href.endsWith('.html') || href.includes('query-index')) {
    url.status = 'error';
    url.error = 'DA does not support XML, HTML, or query index files.';
    return;
  }

  const isExt = EXTS.some((ext) => href.endsWith(`.${ext}`));
  const path = href.endsWith('/') ? `${pathname}index` : pathname;
  const srcPath = isExt ? path : `${path}.md`;
  url.destPath = isExt ? path : `${path}.html`;
  url.editPath = href.endsWith('.json') ? path.replace('.json', '') : path;

  if (isExt) {
    url.route = url.destPath.endsWith('json') ? '/sheet' : '/media';
  } else {
    url.route = '/edit';
  }

  try {
    const resp = await fetch(`${url.origin}${srcPath}`);
    if (resp.redirected && !(srcPath.endsWith('.mp4') || srcPath.endsWith('.png') || srcPath.endsWith('.jpg'))) {
      url.status = 'redir';
      throw new Error('redir');
    }
    if (!resp.ok && resp.status !== 304) {
      url.status = 'error';
      throw new Error('error');
    }
    let content = isExt ? await resp.blob() : await resp.text();
    if (!isExt) {
      const aemHtml = await getAemHtml(url, content);
      if (findFragmentsFlag) await findFragments(url, aemHtml);
      let html = replaceHtml(aemHtml, url.fromOrg, url.fromRepo);
      html = replaceLinks(html, url.fromOrg, url.fromRepo);
      // Linked Assets
      getLinkedAssets(url, html);
      content = new Blob([html], { type: 'text/html' });
    }

    url.status = await saveAllToDa(url, content);
    setProcessed();
  } catch (e) {
    if (!url.status) url.status = 'error';
    // Do nothing
  }
}

export async function importAll(urls, findFragmentsFlag, setProcessed, requestUpdate) {
  // Reset and re-add URLs
  localUrls = urls;

  const uiUpdater = async (url) => {
    await importUrl(url, findFragmentsFlag, setProcessed);
    requestUpdate();
  };

  const queue = new Queue(uiUpdater, 50);

  let notImported;
  while (!notImported || notImported.length > 0) {
    // Check for any non-imported URLs
    notImported = localUrls.filter((url) => !url.status);
    // Wait for the entire import
    await Promise.all(notImported.map((url) => queue.push(url)));
    // Re-check for any non-imported URLs.
    notImported = localUrls.filter((url) => !url.status);
  }
}

/* START - Linked Assets */

function hasLinkedAsset(pageUrl, html) {
  const dom = parser.parseFromString(html, 'text/html');
  const checkAsset = (assetUrl) => {
    const mp4Regex = /https:\/\/main--bacom--adobecom\.(hlx|aem)\.(page|live)\/.*media_.*\.mp4.*/;
    const pdfRegex = /https:\/\/main--bacom--adobecom\.(hlx|aem)\.(page|live)\/.*\.pdf.*/;
    return mp4Regex.test(assetUrl) || assetUrl.includes('.svg') || pdfRegex.test(assetUrl);
  };
  // Links
  const links = dom.body.querySelectorAll('a');
  const hasAssetInAnchor = [...links].some((a) => {
    const href = a.getAttribute('href');
    return checkAsset(href);
  });
  // Image alt text
  const imagesWithAlt = dom.body.querySelectorAll('img[alt*="|"]');
  const hasAssetInAlt = [...imagesWithAlt].some((img) => {
    const [href, alt, icon] = img.alt.split('|');
    href.trim();
    return checkAsset(href);
  });
  // Image source
  const images = dom.body.querySelectorAll('img');
  const hasAssetInSrc = [...images].some((img) => {
    const src = img.getAttribute('src');
    return checkAsset(src);
  });

  return hasAssetInAnchor || hasAssetInAlt || hasAssetInSrc;
}

async function tryFetch(url, cleanPath, tried = false) {
  const result = {};
  try {
    // fetch the html
    const resp = await fetch(url, { redirect: 'error' });

    if (resp.redirected && !(url.endsWith('.mp4') || url.endsWith('.png') || url.endsWith('.jpg'))) {
      throw new Error('redir');
    }
    if (!resp.ok && resp.status !== 304) {
      if (!tried) {
        const bacomResult = await tryFetch(`https://main--bacom--adobecom.aem.live${cleanPath}`, cleanPath, true);
        return bacomResult;
      }

      // pagesWithErrors.push(url);
      // throw new Error('error');
      result.error = url;
    }
    const isExt = false;
    const content = isExt ? await resp.blob() : await resp.text();
    if (!isExt) {
      const aemHtml = await getAemHtml(null, content);
      const html = replaceHtml(aemHtml, 'adobecom', 'bacom');

      // Linked Assets
      if (hasLinkedAsset(url, html)) {
        // console.log('has linked asset:', url);
        // pagesWithLinkedAssets.push(url);
        result.match = url;
        result.error = null;
      }
    }
  } catch (e) {
    // console.log('error:', e.message);
  }
  return result;
}

/* Run this for crawling folder */
(async function getPagesWithLinkedAssets() {
  const pagesWithLinkedAssets = [];
  const pagesWithErrors = [];
  console.log('getPagesWithLinkedAssets');
  const { crawl } = await import('../../public/utils/tree.js');

  const { results } = crawl({
    // Change this path to crawl different folders
    path: '/adobecom/da-bacom/ae_ar',
    callback: async ({ ext, path }) => {
      if (ext !== 'html' || path.includes('/drafts/')) return;

      // Getting some 404s - should I instead be getting from da?
      let cleanPath = path.replace('/adobecom/da-bacom', '').replace('.html', '');
      if (cleanPath.endsWith('/index')) cleanPath = cleanPath.replace('/index', '/');
      const daUrl = `https://main--da-bacom--adobecom.aem.live${cleanPath}`;
      // console.log('Checking file:', url);

      const result = await tryFetch(daUrl, cleanPath);
      if (result.match) pagesWithLinkedAssets.push(result.match);
      if (result.error) pagesWithErrors.push(result.error);
    },
    concurrent: 10,
  });

  results.then((crawlResults) => {
    console.log('total pages crawled:', crawlResults.length);
    console.log('pagesWithLinkedAssets:', pagesWithLinkedAssets);
    console.log('pagesWithErrors:', pagesWithErrors);
  });
}());

/* Uncomment this and run for individual pages at the root */
// (async function getRootPagesWithLinkedAssets() {
//   const pagesWithLinkedAssets = [];
//   const pagesWithErrors = [];
//   console.log('getRootPagesWithLinkedAssets');

//   const paths = [
//     '/404',
//     '/ai',
//     '/customer-success-stories',
//     '/gnav',
//     '/gnav-523test',
//     '/gnav-b',
//     '/gnav-bk-8-7-2023',
//     '/gnav-c',
//     '/gnav-no-nav-aec-logo',
//     '/government',
//     '/graybox-test',
//     '/index',
//     '/preview-page-for-microsoft-login',
//     '/prodtestpage',
//     '/products',
//     '/request-consultation',
//   ];

//   for (const path of paths) {
//     let cleanPath = path.replace('/adobecom/da-bacom', '').replace('.html', '');
//     if (cleanPath.endsWith('/index')) cleanPath = cleanPath.replace('/index', '/');
//     const daUrl = `https://main--da-bacom--adobecom.aem.live${cleanPath}`;
//     // console.log('Checking file:', url);

//     const result = await tryFetch(daUrl, cleanPath);
//     if (result.match) pagesWithLinkedAssets.push(result.match);
//     if (result.error) pagesWithErrors.push(result.error);
//   }

//   console.log('total pages crawled:', paths.length);
//   console.log('pagesWithLinkedAssets:', pagesWithLinkedAssets);
//   console.log('pagesWithErrors:', pagesWithErrors);
// }());
