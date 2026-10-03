// The model gets these controls only: no selectors, JavaScript, URLs, or shell.
const fields = {
    action: { type: 'string', enum: ['click', 'double_click', 'drag', 'type', 'key', 'scroll', 'wait', 'done'] },
    reason: { type: 'string', description: 'Brief visible observation and purpose of the next action.' },
    x: { type: 'integer', minimum: 0, maximum: 1000 },
    y: { type: 'integer', minimum: 0, maximum: 1000 },
    to_x: { type: 'integer', minimum: 0, maximum: 1000 },
    to_y: { type: 'integer', minimum: 0, maximum: 1000 },
    text: { type: 'string', maxLength: 2000 },
    key: { type: 'string', description: 'One supported key or chord, e.g. Enter, Shift+Enter, Ctrl+Backspace, Ctrl+A.' },
    delta: { type: 'integer', minimum: -1500, maximum: 1500, description: 'Vertical scroll pixels, positive down.' },
    seconds: { type: 'number', minimum: 0, maximum: 3 },
};
const inputs = { click: ['x', 'y'], double_click: ['x', 'y'], drag: ['x', 'y', 'to_x', 'to_y'],
  type: ['text'], key: ['key'], scroll: ['x', 'y', 'delta'], wait: ['seconds'], done: [] };
// Every variant requires its own arguments. Small vision models otherwise
// produce a plausible click explanation but omit the optional coordinates.
export const actionSchema = { oneOf: Object.entries(inputs).map(([action, names]) => ({
  type: 'object', additionalProperties: false,
  properties: { action: { const: action }, ...Object.fromEntries(names.map(name => [name, fields[name]])), reason: fields.reason },
  required: ['action', ...names, 'reason'],
})) };

const codes = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
};

export function keyEvent(chord) {
  const parts = String(chord).split('+');
  let key = parts.pop(), modifiers = 0;
  if (new Set(parts).size !== parts.length) throw new Error('Duplicate key modifier');
  for (const part of parts) {
    if (part === 'Ctrl') modifiers |= 2;
    else if (part === 'Shift') modifiers |= 8;
    else throw new Error('Supported modifiers: Ctrl and Shift');
  }
  if (/^[A-Za-z]$/.test(key)) {
    key = key.toLowerCase();
    if (modifiers !== 2 || !['a', 'c', 'x', 'v'].includes(key)) throw new Error('Unsupported letter shortcut');
  } else if (!Object.hasOwn(codes, key)) throw new Error('Unsupported key: ' + key);
  const virtual = codes[key] || key.toUpperCase().charCodeAt(0);
  return { key: key === 'Space' ? ' ' : key,
    code: /^[a-z]$/.test(key) ? 'Key' + key.toUpperCase() : key,
    windowsVirtualKeyCode: virtual, modifiers,
    ...(key === 'Enter' && !(modifiers & 2) ? { text: '\r' } : {}),
    ...(key === 'Space' && !modifiers ? { text: ' ' } : {}),
  };
}

export function validateAction(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Action must be an object');
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) throw new Error('Unknown action field: ' + key);
  if (!Object.hasOwn(inputs, value.action)) throw new Error('Unknown action');
  if (typeof value.reason !== 'string' || value.reason.length > 2000) throw new Error('A brief reason is required');
  const coord = name => {
    if (!Number.isInteger(value[name]) || value[name] < 0 || value[name] > 1000) throw new Error('Invalid coordinate: ' + name);
  };
  if (['click', 'double_click', 'drag', 'scroll'].includes(value.action)) { coord('x'); coord('y'); }
  if (value.action === 'drag') { coord('to_x'); coord('to_y'); }
  if (value.action === 'type' && (typeof value.text !== 'string' || value.text.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value.text))) {
    throw new Error('Type requires plain text, up to 2000 characters');
  }
  if (value.action === 'key') keyEvent(value.key);
  if (value.action === 'scroll' && (!Number.isInteger(value.delta) || Math.abs(value.delta) > 1500)) throw new Error('Invalid scroll distance');
  if (value.action === 'wait' && (!Number.isFinite(value.seconds) || value.seconds < 0 || value.seconds > 3)) throw new Error('Invalid wait duration');
  return value;
}

export async function performAction(browser, value, viewport) {
  const a = validateAction(value);
  const point = (x, y) => ({ x: x * (viewport.width - 1) / 1000, y: y * (viewport.height - 1) / 1000 });
  const mouse = (type, extra = {}, x = a.x, y = a.y) => browser.command('Input.dispatchMouseEvent', { type, ...point(x, y), ...extra });
  if (a.action === 'click' || a.action === 'double_click') {
    for (let clickCount = 1; clickCount <= (a.action === 'double_click' ? 2 : 1); clickCount++) {
      await mouse('mousePressed', { button: 'left', buttons: 1, clickCount });
      await mouse('mouseReleased', { button: 'left', buttons: 0, clickCount });
    }
  } else if (a.action === 'drag') {
    await mouse('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    for (let n = 1; n <= 8; n++) await mouse('mouseMoved', { button: 'left', buttons: 1 },
      a.x + (a.to_x - a.x) * n / 8, a.y + (a.to_y - a.y) * n / 8);
    await mouse('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 }, a.to_x, a.to_y);
  } else if (a.action === 'type') await browser.command('Input.insertText', { text: a.text });
  else if (a.action === 'key') {
    const event = keyEvent(a.key);
    await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    delete event.text;
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  } else if (a.action === 'scroll') await mouse('mouseWheel', { deltaX: 0, deltaY: a.delta });
  else if (a.action === 'wait') await new Promise(resolve => setTimeout(resolve, a.seconds * 1000));
}
