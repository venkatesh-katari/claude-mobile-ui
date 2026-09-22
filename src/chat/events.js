/**
 * Pure reducers for the backend-neutral event protocol. Keeping stream
 * assembly outside React makes ordering, de-duplication, and reconnect replay
 * deterministic and fixture-testable.
 */

function withStreamingAssistant(messages, update) {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role === 'assistant' && last._streaming) {
    next[next.length - 1] = update(last);
  } else {
    next.push(update({ role: 'assistant', parts: [], _streaming: true }));
  }
  return next;
}

export function appendTextDelta(messages, text) {
  if (!text) return messages;
  return withStreamingAssistant(messages, assistant => {
    const parts = [...assistant.parts];
    const lastPart = parts[parts.length - 1];
    if (lastPart?.type === 'text') {
      parts[parts.length - 1] = { ...lastPart, text: `${lastPart.text}${text}` };
    } else {
      parts.push({ type: 'text', text });
    }
    return { ...assistant, parts };
  });
}

export function upsertToolEvent(messages, event) {
  return withStreamingAssistant(messages, assistant => {
    const parts = [...assistant.parts];
    const index = parts.findIndex(part => part.type === 'tool_use' && part.id === event.id);
    const toolPart = {
      type: 'tool_use',
      id: event.id,
      name: event.name,
      input: event.input || {},
      output: event.output,
      status: event.status,
      isError: event.isError,
    };
    if (index >= 0) parts[index] = { ...parts[index], ...toolPart };
    else parts.push(toolPart);
    return { ...assistant, parts };
  });
}

export function completeTurn(messages, event) {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role !== 'assistant') return next;
  const usd = event.cost?.usd;
  const tokens = event.cost?.tokens;
  next[next.length - 1] = {
    ...last,
    _streaming: false,
    ...(usd ? { cost: usd } : {}),
    ...(tokens ? { tokens } : {}),
    ...(event.durationMs ? { duration: event.durationMs } : {}),
  };
  return next;
}

export function finishStream(messages) {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role === 'assistant') next[next.length - 1] = { ...last, _streaming: false };
  return next;
}
