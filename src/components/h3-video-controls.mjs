import hardwareProfiles from '../config/minimaxH3HardwareProfiles.json' with { type: 'json' };

function controlsFor(vendor) {
  const profile = hardwareProfiles[vendor];
  return {
    name: profile.name,
    hardware: profile.vendor,
    settings: { ...profile.settings },
    nodeOverrides: {},
    outputNodeIds: null,
  };
}

export const H3_NVIDIA_CONTROLS = controlsFor('nvidia');
export const H3_AMD_CONTROLS = controlsFor('amd');

export const H3_HARDWARE_CONTROLS = { nvidia: H3_NVIDIA_CONTROLS, amd: H3_AMD_CONTROLS };

// Keep this alias for callers that only need the conservative H3 defaults.
export const H3_DEFAULT_CONTROLS = H3_AMD_CONTROLS;

export function isMiniMaxH3Workflow(manifest) {
  return manifest?.modelType === 'minimax_h3' || manifest?.promptProfile?.family === 'minimax_h3';
}
