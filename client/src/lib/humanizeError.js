export function humanizeError(error, fallback = 'Something went wrong') {
  const message = typeof error === 'string' ? error : error?.message
  if (!message) return fallback

  if (/ANTHROPIC_API_KEY/i.test(message)) {
    return 'AI answers are not configured for this environment yet. Add the server API key, then try again.'
  }
  if (/server unreachable|failed to fetch|networkerror|network request failed/i.test(message)) {
    return 'CodeArchitect cannot reach its analysis service. Check the connection and try again.'
  }
  if (/410|re-?upload|no longer available/i.test(message)) {
    return 'This uploaded project is no longer available on the server. Open the folder again to restore it.'
  }
  if (/failed to chunk|failed to load file/i.test(message)) {
    return 'This file could not be analyzed. Try reopening it or choose another file.'
  }

  return message
}
