// The web app's tsconfig loads no vite/client types; this is the one asset URL import WP43 needs.
declare module '@wllama/wllama/esm/wasm/wllama.wasm?url' {
  const url: string;
  export default url;
}
