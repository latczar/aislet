// The phone's models (Qwen3 and Qwen3.5) read chats in the ChatML format. Their own templates write a past reply
// without the empty thinking block it was generated after, so the next prompt stops matching the saved reading at
// the first reply and the phone reads the rest of the chat again (40-50 s on a phone CPU). Written here exactly as
// each reply was generated, every prompt starts with the whole of the one before, so only the new message is read.

/** What follows "assistant" when thinking is off: the reply comes straight after it. */
export const NO_THINKING = '<think>\n\n</think>\n\n';

/** The system message alone, up to where the first message starts: read ahead so a new chat only reads what's typed. */
export function chatmlSystem(system: string): string {
  return `<|im_start|>system\n${system.trim()}<|im_end|>\n<|im_start|>user\n`;
}

export function chatmlPrompt(messages: { role: string; content: string }[]): string {
  let prompt = '';
  for (const m of messages) {
    prompt += `<|im_start|>${m.role}\n${m.role === 'assistant' ? NO_THINKING : ''}${m.content.trim()}<|im_end|>\n`;
  }
  return `${prompt}<|im_start|>assistant\n${NO_THINKING}`;
}
