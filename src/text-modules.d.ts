// snapshot.js is bundled as a string (scripts/build.mjs) and evaluated in the page.
declare module "*/snapshot.js" {
  const source: string;
  export default source;
}
