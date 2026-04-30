declare module "*.svg?url" {
  const content: string;
  export default content;
}

declare module "*?url" {
  const content: string;
  export default content;
}
