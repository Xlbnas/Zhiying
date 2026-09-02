#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputDir = path.join(root, 'outputs/extreme-long-video/assets/archive');
const api = 'https://commons.wikimedia.org/w/api.php';
const assets = [
  ['File:Frederic Bartlett in 1948.jpg', '01-frederic-bartlett.jpg', 'Bartlett and the reconstructive-memory history'],
  ['File:FranzBoas.jpg', '02-franz-boas.jpg', 'Cultee to Boas to Bartlett provenance chain'],
  ['File:Elizabeth Loftus.jpg', '03-elizabeth-loftus.jpg', 'Misinformation-effect research history'],
  ['File:Gray 718-amygdala.png', '04-gray-amygdala.png', 'Animal reconsolidation study context'],
  ['File:St. Louis Police Lantern Slides- Lineup room. - DPLA - 27075ec69414cd73820bdf76f0cb6a72.jpg', '05-lineup-room-a.jpg', 'Historical eyewitness-identification procedure'],
  ['File:St. Louis Police Lantern Slides- Lineup room. - DPLA - 3aca7e00dc4babf4b3d7424214663ee8.jpg', '06-lineup-room-b.jpg', 'Alternative historical lineup-room view'],
  ['File:Indiana family photo, c. 1900.jpg', '07-indiana-family.jpg', 'Family corroboration and autobiographical-memory context'],
  ['File:Daguerreotype of The Doty Family by Robert Peckham.jpg', '08-doty-family.jpg', 'Historical family-album material'],
  ['File:Boone County Courthouse courtroom front.jpg', '09-boone-courtroom.jpg', 'Testimony and later courtroom confidence'],
  ['File:Beverley Guildhall Courtroom.jpg', '10-courtroom.jpg', 'Judicial setting without a real case reenactment'],
  ['File:Australian Army Y.M.C.A. in Julis Camp. Group of soldiers listening to the radio LOC matpc.20685.jpg', '11-radio-listeners.jpg', 'How people receive consequential public news'],
  ['File:Girl listening to radio.gif', '12-radio-listener.gif', 'Alternative public-news reception context'],
  ['File:Arthur H. Thomas Company. Laboratory apparatus and instruments. Catalogue 1914.pdf', '13-laboratory-catalog.jpg', 'Historical laboratory material'],
  ['File:Experimental psychology and the psychological laboratory in the University of Toronto (microform) (IA cihm 01349).pdf', '14-psychology-laboratory.jpg', 'Historical experimental-psychology context'],
  ['File:Grace Julian Clarke freshman lectures notebook, 1880-1893 - DPLA - c7d173cf312b48aa477541bbcccae752 (page 37).jpg', '15-notebook-page-37.jpg', 'External record as a memory baseline'],
  ['File:Grace Julian Clarke freshman lectures notebook, 1880-1893 - DPLA - c7d173cf312b48aa477541bbcccae752 (page 58).jpg', '16-notebook-page-58.jpg', 'A later page for version comparison'],
  ['File:Nanney notebook, folio 21r (4909953).jpg', '17-notebook-folio.jpg', 'Written trace and source-attribution context'],
  ['File:CE 1611 FBI report of interview of Detective D.L. Blankenship, Dallas Police Department - DPLA - 4207ff58dc83ebd2df6becbad9496eaf.pdf', '18-interview-record.jpg', 'Preserving the first interview record'],
  ['File:CE 2146 WFAA-TV reel PKT 12, entitled "Interview of Police Chief Jesse Curry by Press, Dallas Police and Courts Building" - DPLA - abff7b35e2b5896e88ba72c67f572079.pdf', '19-press-interview-record.jpg', 'Repeated questioning and public feedback context'],
  ['File:Kathlamet texts (IA kathlamettexts00boas).pdf', '20-kathlamet-texts.jpg', 'Primary source volume behind the Bartlett story chain'],
];
const allowedLicenses = new Set(['Public domain', 'CC0', 'CC BY-SA 4.0', 'No restrictions']);
const textValue = (metadata, key) => metadata?.[key]?.value?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
const request = (url) => fetch(url, {headers: {'User-Agent': 'ZhiyingResearch/1.0 (archive asset acquisition)'}});
const requestWithRetry = async (url, label) => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await request(url);
    if (response.ok) return response;
    if (response.status !== 429 || attempt === 5) throw new Error(`${label}: request ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
  }
  throw new Error(`${label}: request retry exhausted`);
};
const download = async (url, title) => {
  const response = await requestWithRetry(url, `${title}: download`);
  return Buffer.from(await response.arrayBuffer());
};

fs.mkdirSync(outputDir, {recursive: true});
const records = [];
for (const [title, filename, narrativeRole] of assets) {
  const query = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '1920',
    format: 'json',
    origin: '*',
  });
  const response = await requestWithRetry(`${api}?${query}`, `${title}: Commons API`);
  const payload = await response.json();
  const page = Object.values(payload.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) throw new Error(`${title}: imageinfo missing`);
  const metadata = info.extmetadata ?? {};
  const license = textValue(metadata, 'LicenseShortName');
  if (!allowedLicenses.has(license)) throw new Error(`${title}: license ${license || 'UNKNOWN'} not allowlisted`);
  const sourceUrl = info.descriptionurl;
  const downloadUrl = info.thumburl ?? info.url;
  const localPath = path.join(outputDir, filename);
  const bytes = fs.existsSync(localPath) && fs.statSync(localPath).size >= 1000
    ? fs.readFileSync(localPath)
    : await download(downloadUrl, title);
  if (bytes.length < 1000) throw new Error(`${title}: downloaded file too small`);
  if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, bytes);
  records.push({
    id: `A${String(records.length + 1).padStart(2, '0')}`,
    title,
    filename,
    narrativeRole,
    sourceProvider: 'Wikimedia Commons',
    sourceUrl,
    downloadUrl,
    license,
    licenseUrl: textValue(metadata, 'LicenseUrl'),
    creator: textValue(metadata, 'Artist'),
    credit: textValue(metadata, 'Credit'),
    attributionRequired: !['Public domain', 'CC0', 'No restrictions'].includes(license),
    bytes: bytes.length,
    acquisitionState: /third parties have made copyright claims/i.test(textValue(metadata, 'Credit'))
      ? 'rights-conflict-review-required'
      : 'physical-file-and-item-metadata-verified',
  });
  console.log(`[asset] ${filename} ${license} ${bytes.length} bytes`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
fs.writeFileSync(path.join(outputDir, 'provenance.json'), `${JSON.stringify({
  schemaVersion: 'extreme-long-video-archive-assets@1',
  acquiredAt: new Date().toISOString(),
  policy: 'Only item pages whose Commons metadata matched the explicit license allowlist were downloaded. Narrative binding remains a separate production step.',
  count: records.length,
  usableCount: records.filter((record) => record.acquisitionState === 'physical-file-and-item-metadata-verified').length,
  assets: records,
}, null, 2)}\n`);
console.log(`[asset] complete count=${records.length}`);
