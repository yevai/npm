/**
 * Formats a message, prints it to the console with a prefix, and returns it.
 *
 * @example
 * ```ts
 * import { print } from "@yai/example";
 *
 * const message = print("hello world");
 * // Logs: "logString hello world"
 * // message: "logString hello world"
 * ```
 *
 * @param logString - The text content to be formatted and logged.
 * @returns The final formatted log string.
 */
export const print = (logString: string) => {
  const result = `logString ${logString}`;
  console.log(result);
  return result;
};
