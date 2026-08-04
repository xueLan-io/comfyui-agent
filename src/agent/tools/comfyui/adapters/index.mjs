import { WorkflowAdapter } from '../workflow-adapter.mjs';
import { SDXLAdapter } from './sdxl.mjs';
import { FluxAdapter } from './flux.mjs';
import { AnimateDiffAdapter } from './animatediff.mjs';

export function registerAdapters() {
  WorkflowAdapter.register('sdxl', SDXLAdapter);
  WorkflowAdapter.register('flux', FluxAdapter);
  WorkflowAdapter.register('animatediff', AnimateDiffAdapter);
}
