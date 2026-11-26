// Vercel entry point. vercel.json rewrites every /api/* request here.
import {createHandler} from '../server/index.js';

export default createHandler();
