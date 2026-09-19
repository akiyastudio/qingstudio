const parsePythonJsonMessages = output => String(output || '')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
  .flatMap(line => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  });

const findPythonJsonFailureMessage = messages => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if ((message?.type === 'error' || message?.type === 'cancelled') && String(message.message || '').trim()) {
      return String(message.message).trim();
    }
  }
  return '';
};

const classifyPythonJsonMessage = message => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { kind: 'ignore' };
  if (message.type === 'error' || message.type === 'cancelled') {
    return { kind: message.type, message: String(message.message || '').trim() };
  }
  if (message.type === 'progress') return { kind: 'progress' };
  if (message.type === 'success' || message.success === true) return { kind: 'success', value: message };
  if (!message.type) return { kind: 'success', value: message };
  return { kind: 'message' };
};

module.exports = { classifyPythonJsonMessage, findPythonJsonFailureMessage, parsePythonJsonMessages };
