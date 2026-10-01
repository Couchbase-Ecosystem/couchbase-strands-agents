// Minimal types for the README's local-embedding example. @huggingface/transformers pulls in about 300 MB of
// ONNX Runtime binaries, too much to install just to type-check one snippet.
declare module '@huggingface/transformers' {
  export interface Tensor {
    data: Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array
  }
  export type FeatureExtractionPipeline = (
    text: string | string[],
    options?: { pooling?: 'none' | 'mean' | 'cls'; normalize?: boolean }
  ) => Promise<Tensor>
  export function pipeline(task: 'feature-extraction', model?: string): Promise<FeatureExtractionPipeline>
}
