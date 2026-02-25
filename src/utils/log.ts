export function logVerbose(enabled: boolean, message: string): void {
  if (enabled) {
    console.log(message);
  }
}
