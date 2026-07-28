declare module "virtual:executor-inner-renderer" {
  const source: string;
  export default source;
}

declare module "virtual:executor-tailwind-browser" {
  const source: string;
  export default source;
}

declare module "*.css?raw" {
  const source: string;
  export default source;
}
