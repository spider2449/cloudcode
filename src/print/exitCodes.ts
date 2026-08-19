export const EXIT_CODES = {
  success: 0,
  executionError: 1,
  invalidConfiguration: 2,
  permissionDenied: 3,
  limitReached: 4,
  verificationFailed: 5,
  taskConflict: 6,
  networkDenied: 7,
  interrupted: 130
} as const;
