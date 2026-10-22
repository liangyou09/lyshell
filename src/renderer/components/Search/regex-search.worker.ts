import { searchText } from './text-search'

self.onmessage = (event) => {
  const { text, query, options } = event.data
  try { self.postMessage({ result: searchText(text, query, options) }) }
  catch { self.postMessage({ error: 'Invalid regular expression' }) }
}
