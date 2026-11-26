// PC: the laptop is this computer, so there's nothing to look for.
export async function findLaptops(
  _onFound: (address: string) => void,
  _onProgress: (fraction: number) => void,
  _cancelled: AbortSignal,
): Promise<string[]> {
  return [];
}

export async function findOurLaptop(
  _key: string,
  _cancelled: AbortSignal,
  _onProgress?: (fraction: number) => void,
): Promise<string | null> {
  return null;
}
