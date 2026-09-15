import { ModelRuntime } from '@earendil-works/pi-coding-agent';
const runtime = await ModelRuntime.create();
for (const model of await runtime.getAvailable()) console.log(`${model.provider}/${model.id}`);
