declare module '@redactpii/node' {
  export interface RedactorOptions {
    aggressive?: boolean;
  }

  export class Redactor {
    constructor(options?: RedactorOptions);
    redact(text: string): string;
  }
}
