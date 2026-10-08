import {env} from 'cloudflare:workers';
import {handleApi} from '@/lib/api';
import type {CloudEnv} from '@/lib/types';
const route = (request: Request) => handleApi(request, env as unknown as CloudEnv);
export {route as GET, route as POST, route as PUT};
