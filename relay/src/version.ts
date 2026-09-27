// The relay's reported version: the build's commit when the image sets RELAY_VERSION, else a dev tag.
export const RELAY_VERSION: string = process.env.RELAY_VERSION?.trim() || '0.1.0-dev';
