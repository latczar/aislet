// Stand-in for src/hub.ts. The eval passes its own `send` to the Ollama engine, so only these names are needed.
export class HubError extends Error {}
export async function readLines(res, onLine) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}
export async function hubSearch() {
  return [];
}
