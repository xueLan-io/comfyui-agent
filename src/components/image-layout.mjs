export function outputGalleryClass(count) {
  if (count <= 1) return 'single-result';
  if (count <= 4) return 'standard-gallery';
  return 'dense-gallery';
}
