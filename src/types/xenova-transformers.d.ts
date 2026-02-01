declare module '@huggingface/transformers' {
  export function pipeline(
    task: string,
    model?: string,
    options?: Record<string, any>
  ): Promise<(input: string, options?: Record<string, any>) => Promise<{ data: Float32Array }>>;

  export const env: {
    localModelPath: string;
    allowRemoteModels: boolean;
    cacheDir: string;
    backends: {
      onnx: {
        executionProviders: string[];
      };
    };
  };
}
