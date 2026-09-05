import { PonsError } from './intent';
export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  code: string,
  status = 504,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PonsError(status, code));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
