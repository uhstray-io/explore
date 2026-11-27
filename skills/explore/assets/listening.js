// How long the agent keeps listening for work (K1). Shared by the server, which reports it in every idle
// response, and the browser, where the user chooses it. An agent waits only while its session stays open.
export const listenChoices = [2, 10, 30, 60];
export const defaultListenMinutes = 2;

// A listener's state, counted from its last activity: the last job handed to it, or the last saved change to
// a map it covers. It keeps listening until a whole window passes without either.
export function listenStatus({ windowMinutes, lastActivity, now }) {
  const idleSeconds = Math.max(0, Math.floor((now - lastActivity) / 1000));
  return { windowMinutes, idleSeconds, keepListening: idleSeconds < windowMinutes * 60 };
}
