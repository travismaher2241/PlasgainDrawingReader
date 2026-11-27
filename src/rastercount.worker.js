// Runs the symbol search off the page's main thread, so the app stays usable
// while a large sheet image is searched.
import {countSymbol} from './rastercount.js';

self.onmessage = ({data}) => {
  try {
    self.postMessage({result: countSymbol(data.image, data.box, {minScore: data.minScore})});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
