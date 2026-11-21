/**
 * The pinned suggestion model (WP43). One model, pinned to a Hugging Face
 * commit and checked against its SHA-256 after the download, so the file a
 * browser keeps is exactly the one listed here. Pure data.
 *
 * Granite 4.0 350M Base (IBM, Apache-2.0, redistribution allowed) in IBM's
 * own Q4_K_M GGUF. It is a base model trained for fill-in-the-middle, so it
 * sees the text after the caret as well as before it.
 */

export interface ModelManifest {
  id: string;
  /** What the settings row calls it. */
  label: string;
  /** Hugging Face repository and the commit it is pinned to. */
  repo: string;
  revision: string;
  file: string;
  /** Where the browser downloads it from (redirects to a *.hf.co CDN host). */
  url: string;
  bytes: number;
  /** Lower-case hex SHA-256 of the whole file. */
  sha256: string;
  licence: string;
  /** Fill-in-the-middle tokens, in prefix-suffix-middle order. */
  fim: { prefix: string; suffix: string; middle: string };
  /** Tokens that end a suggestion. */
  stops: readonly string[];
}

/** The model host: the only place the browser contacts for this feature. */
export const MODEL_HOST = 'https://huggingface.co';

const repo = 'ibm-granite/granite-4.0-350m-base-GGUF';
const revision = 'b2628819fb4e3ee4a42988e532483124b3366bd2';
const file = 'granite-4.0-350m-base-Q4_K_M.gguf';

export const GRANITE_350M: ModelManifest = {
  id: 'granite-4.0-350m-base-q4_k_m',
  label: 'Granite 4.0 350M',
  repo,
  revision,
  file,
  url: `${MODEL_HOST}/${repo}/resolve/${revision}/${file}`,
  bytes: 236_979_072,
  sha256: '2c22ed74d6c11791eb017886e1356ae11a6b8207b1ab2c1dfee047370110389a',
  licence: 'Apache-2.0',
  fim: { prefix: '<|fim_prefix|>', suffix: '<|fim_suffix|>', middle: '<|fim_middle|>' },
  stops: ['<|end_of_text|>', '<|fim_pad|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>'],
};

/** The model the feature uses. */
export const MODEL: ModelManifest = GRANITE_350M;

/** "237 MB": decimal megabytes, as download sizes are usually shown. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
