import { WorkflowAdapter } from '../workflow-adapter.mjs';
import { SDXLAdapter } from './sdxl.mjs';
import { FluxAdapter } from './flux.mjs';
import { AnimateDiffAdapter } from './animatediff.mjs';
import { WanAdapter } from './wan.mjs';
import { MiniMaxH3Adapter } from './minimax-h3.mjs';

export function registerAdapters() {
  WorkflowAdapter.register('sdxl', SDXLAdapter);
  WorkflowAdapter.register('flux', FluxAdapter);
  WorkflowAdapter.register('animatediff', AnimateDiffAdapter);
  WorkflowAdapter.register('wan', WanAdapter);
  WorkflowAdapter.register('minimax_h3', MiniMaxH3Adapter);
}
