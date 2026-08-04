import test from 'node:test';
import assert from 'node:assert/strict';
import { outputGalleryClass } from '../src/components/image-layout.mjs';

test('single output uses the large bounded preview layout', () => {
  assert.equal(outputGalleryClass(1), 'single-result');
  assert.equal(outputGalleryClass(0), 'single-result');
});

test('two to four outputs use an equal gallery layout', () => {
  assert.equal(outputGalleryClass(2), 'standard-gallery');
  assert.equal(outputGalleryClass(4), 'standard-gallery');
});

test('larger batches use the dense gallery layout', () => {
  assert.equal(outputGalleryClass(5), 'dense-gallery');
});
