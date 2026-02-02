declare module 'cross-spawn' {
  import { ChildProcess, SpawnOptions } from 'child_process';

  function spawn(
    command: string,
    args?: ReadonlyArray<string>,
    options?: SpawnOptions
  ): ChildProcess;

  export = spawn;
}
