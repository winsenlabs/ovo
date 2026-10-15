export {
  Emitter,
  type RoomCaption,
  type RoomClient,
  type RoomConnectionState,
  type RoomGrant,
  type RoomLevels,
} from './client.ts';
export { createFakeRoomClient, type FakeRoomClient, type FakeRoomOptions } from './fake.ts';
export { createRoomClient, registerRoomAdapter, UnsupportedRoomProviderError } from './factory.ts';
export {
  classifyMicrophoneFailure,
  listAudioDevices,
  MicrophoneError,
  probeMicrophone,
  type AudioDevice,
  type AudioDevices,
  type MediaAccess,
  type MicrophoneFailure,
  type MicrophoneProbe,
} from './devices.ts';
