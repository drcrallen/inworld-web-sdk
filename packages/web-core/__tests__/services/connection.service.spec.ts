import '../mocks/window.mock';

import WS from 'jest-websocket-mock';
import { v4 } from 'uuid';

import {
  ActorType,
  ControlEventAction,
  DataChunkDataType,
  InworldPacket as ProtoPacket,
} from '../../proto/ai/inworld/packets/packets.pb';
import { TtsPlaybackAction } from '../../src/common/data_structures';
import { protoTimestamp } from '../../src/common/helpers';
import {
  CHAT_HISTORY_TYPE,
  HistoryItem,
  InworldHistory,
} from '../../src/components/history';
import { GrpcAudioPlayback } from '../../src/components/sound/grpc_audio.playback';
import { GrpcWebRtcLoopbackBiDiSession } from '../../src/components/sound/grpc_web_rtc_loopback_bidi.session';
import { WebSocketConnection } from '../../src/connection/web-socket.connection';
import { InworldPacket } from '../../src/entities/inworld_packet.entity';
import { SessionToken } from '../../src/entities/session_token.entity';
import { EventFactory } from '../../src/factories/event';
import { ConnectionService } from '../../src/services/connection.service';
import {
  SessionState,
  StateSerializationService,
} from '../../src/services/pb/state_serialization.service';
import { WorldEngineService } from '../../src/services/pb/world_engine.service';
import {
  capabilitiesProps,
  convertAgentsToCharacters,
  convertPacketFromProto,
  createAgent,
  generateSessionToken,
  previousState,
  SCENE,
  session,
  user,
  writeMock,
} from '../helpers';

const onError = jest.fn();
const onMessage = jest.fn();
const onDisconnect = jest.fn();
const onInterruption = jest.fn();
const agents = [createAgent(), createAgent()];
const characters = convertAgentsToCharacters(agents);
const scene = { agents };
const grpcAudioPlayer = new GrpcAudioPlayback();
const webRtcLoopbackBiDiSession = new GrpcWebRtcLoopbackBiDiSession();
const eventFactory = new EventFactory();
eventFactory.setCurrentCharacter(characters[0]);

const textEvent = eventFactory.text(v4());
const audioEvent = eventFactory.dataChunk(v4(), DataChunkDataType.AUDIO);
const incomingTextEvent: ProtoPacket = {
  packetId: {
    ...textEvent.packetId,
    utteranceId: v4(),
  },
  routing: {
    source: {
      name: v4(),
      type: ActorType.AGENT,
    },
    targets: [
      {
        name: characters[0].id,
        type: ActorType.PLAYER,
      },
    ],
  },
  text: {
    text: v4(),
    final: false,
  },
};

test('should return event factory', () => {
  const connection = new ConnectionService();

  expect(connection.getEventFactory()).toBeInstanceOf(EventFactory);
});

test('should close', async () => {
  const close = jest
    .spyOn(WebSocketConnection.prototype, 'close')
    .mockImplementationOnce(jest.fn());

  jest
    .spyOn(WorldEngineService.prototype, 'loadScene')
    .mockImplementationOnce(() => Promise.resolve(scene));
  jest
    .spyOn(WebSocketConnection.prototype, 'open')
    .mockImplementationOnce(jest.fn());

  const connection = new ConnectionService({
    name: SCENE,
    config: {
      connection: { autoReconnect: false },
      capabilities: capabilitiesProps,
    },
    user,
    onReady: () => {
      expect(connection.isActive()).toEqual(true);

      connection.close();

      expect(connection.isActive()).toEqual(false);
      expect(close).toHaveBeenCalledTimes(1);
    },
    onError,
    onMessage,
    onDisconnect,
    grpcAudioPlayer,
    generateSessionToken,
    webRtcLoopbackBiDiSession,
  });

  await connection.open();
});

describe('history', () => {
  let connection: ConnectionService;

  beforeEach(() => {
    connection = new ConnectionService();
  });

  test('should get history', () => {
    const get = jest
      .spyOn(InworldHistory.prototype, 'get')
      .mockImplementationOnce(jest.fn());

    connection.getHistory();

    expect(get).toHaveBeenCalledTimes(1);
  });

  test('should clear history', () => {
    const clear = jest
      .spyOn(InworldHistory.prototype, 'clear')
      .mockImplementationOnce(jest.fn());

    connection.clearHistory();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  test('should return transcript', () => {
    const result = 'test';
    const getTranscript = jest
      .spyOn(InworldHistory.prototype, 'getTranscript')
      .mockImplementationOnce(() => result);

    const transcript = connection.getTranscript();

    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(transcript).toEqual(result);
  });
});

describe('getSessionState', () => {
  let connection: ConnectionService;
  let generateSessionToken: jest.Mock;

  beforeEach(() => {
    generateSessionToken = jest.fn(() => Promise.resolve(session));
    connection = new ConnectionService({
      name: SCENE,
      onError,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });
  });

  test('should get state', async () => {
    const expected: SessionState = {
      state: previousState,
      creationTime: protoTimestamp(),
    };
    const getSessionState = jest
      .spyOn(StateSerializationService.prototype, 'getSessionState')
      .mockImplementationOnce(() => Promise.resolve(expected));

    const result = await connection.getSessionState();

    expect(generateSessionToken).toHaveBeenCalledTimes(1);
    expect(getSessionState).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expected);
  });

  test('should catch error and pass it to handler', async () => {
    const err = new Error();
    const getSessionState = jest
      .spyOn(StateSerializationService.prototype, 'getSessionState')
      .mockImplementationOnce(() => {
        throw err;
      });

    await connection.getSessionState();

    expect(generateSessionToken).toHaveBeenCalledTimes(1);
    expect(getSessionState).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });
});

describe('open', () => {
  let connection: ConnectionService;

  beforeEach(() => {
    connection = new ConnectionService({
      name: SCENE,
      config: { capabilities: capabilitiesProps },
      user,
      onError,
      onMessage,
      onDisconnect,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });
  });

  test('should execute without errors', async () => {
    const loadScene = jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    const openSession = jest
      .spyOn(WebSocketConnection.prototype, 'open')
      .mockImplementationOnce(jest.fn());
    const setCharacters = jest.spyOn(EventFactory.prototype, 'setCharacters');

    await connection.open();

    await connection.loadCharacters();
    eventFactory.getCharacters();

    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(setCharacters).toHaveBeenCalledTimes(1);
    expect(setCharacters).toHaveBeenCalledWith(characters);
  });

  test('should catch error on load scene and pass it to handler', async () => {
    const err = new Error();
    const loadScene = jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.reject(err));

    await connection.open();

    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  test('should catch error on connection establishing and pass it to handler', async () => {
    const err = new Error();
    const loadScene = jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    const openSession = jest
      .spyOn(WebSocketConnection.prototype, 'open')
      .mockImplementationOnce(() => Promise.reject(err));

    await connection.open();

    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  test('should not generate actual token twice', async () => {
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));

    const generateSessionToken = jest.fn(() => Promise.resolve(session));

    const connection = new ConnectionService({
      name: SCENE,
      config: { capabilities: capabilitiesProps },
      user,
      onError,
      onMessage,
      onDisconnect,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    await connection.open();
    await connection.open();

    expect(generateSessionToken).toHaveBeenCalledTimes(1);
  });

  test('should regenerate expired token', async () => {
    const expiredSession: SessionToken = {
      sessionId: v4(),
      token: v4(),
      type: 'Bearer',
      expirationTime: protoTimestamp(),
    };

    const generateSessionToken = jest.fn(() => Promise.resolve(expiredSession));

    const connection = new ConnectionService({
      name: SCENE,
      config: { capabilities: capabilitiesProps },
      user,
      onError,
      onMessage,
      onDisconnect,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(WebSocketConnection.prototype, 'open')
      .mockImplementationOnce(jest.fn());
    await connection.open();

    await connection.open();

    expect(generateSessionToken).toHaveBeenCalledTimes(2);
  });
});

describe('open manually', () => {
  let connection: ConnectionService;

  beforeEach(() => {
    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { autoReconnect: false, gateway: { hostname: '' } },
        capabilities: capabilitiesProps,
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });
  });

  test('should throw error in case of openManually call without autoreconnect', async () => {
    connection = new ConnectionService({
      name: SCENE,
      config: { capabilities: capabilitiesProps },
      user,
      onError,
      onMessage,
      onDisconnect,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    await connection.openManually();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toEqual(
      'Impossible to open connection manually with `autoReconnect` enabled',
    );
  });

  test('should throw error in case openManually call with active connection', async () => {
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));

    await connection.openManually();
    await connection.openManually();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toEqual(
      'Connection is already open',
    );
  });

  test('should open connection', async () => {
    const open = jest
      .spyOn(ConnectionService.prototype, 'open')
      .mockImplementationOnce(jest.fn());
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));

    await connection.openManually();

    expect(open).toHaveBeenCalledTimes(1);
  });

  test('should add previous state packets to history', async () => {
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() =>
        Promise.resolve({
          ...scene,
          previousState: {
            stateHolders: [
              {
                packets: [incomingTextEvent],
              },
            ],
          },
        }),
      );

    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { autoReconnect: false, gateway: { hostname: '' } },
        capabilities: capabilitiesProps,
        history: { previousState: true },
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      onHistoryChange: (history: HistoryItem[], diff: HistoryItem[]) => {
        const result = [convertPacketFromProto(incomingTextEvent)];

        expect(diff).toEqual(result);
        expect(history).toEqual(result);
      },
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    await connection.openManually();
  });
});

describe('send', () => {
  let server: WS;
  const HOSTNAME = 'localhost:1234';

  let connection: ConnectionService;

  const onHistoryChange = jest.fn();

  beforeEach(() => {
    server = new WS(`ws://${HOSTNAME}/v1/session/default`, {
      jsonProtocol: true,
    });

    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: '' } },
        capabilities: capabilitiesProps,
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      onInterruption,
      onHistoryChange,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });
  });

  afterEach(() => {
    server.close();
    WS.clean();
  });

  test('should throw error in case of connection is inactive on send call', async () => {
    const connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: '' }, autoReconnect: false },
        capabilities: capabilitiesProps,
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      onHistoryChange,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });
    const isActive = jest
      .spyOn(connection, 'isActive')
      .mockImplementationOnce(() => false);
    const open = jest.spyOn(ConnectionService.prototype, 'open');

    await connection.send(() => ({}));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toEqual(
      'Unable to send data due inactive connection',
    );
    expect(isActive).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(0);
  });

  test('should send textEvent without errors', async () => {
    const open = jest.spyOn(ConnectionService.prototype, 'open');
    const write = jest
      .spyOn(WebSocketConnection.prototype, 'write')
      .mockImplementationOnce(writeMock);
    jest
      .spyOn(WebSocketConnection.prototype, 'open')
      .mockImplementationOnce(jest.fn());
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));

    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: '' } },
        capabilities: capabilitiesProps,
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      onHistoryChange: (history: HistoryItem[]) => {
        expect(history).toEqual([
          {
            id: textEvent.packetId.utteranceId,
            characters: [],
            correlationId: textEvent.packetId.correlationId,
            date: new Date(textEvent.timestamp),
            interactionId: textEvent.packetId.interactionId,
            isRecognizing: false,
            source: {
              isCharacter: false,
              isPlayer: true,
              name: undefined,
            },
            text: textEvent.text.text,
            type: CHAT_HISTORY_TYPE.ACTOR,
          },
        ]);
      },
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    await connection.send(() => textEvent);

    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('should interrupt on text sending', async () => {
    const interactionId = v4();
    const utteranceId = v4();
    const write = jest
      .spyOn(WebSocketConnection.prototype, 'write')
      .mockImplementation(writeMock);
    const cancelResponse = jest.spyOn(EventFactory.prototype, 'cancelResponse');
    const open = jest
      .spyOn(WebSocketConnection.prototype, 'open')
      .mockImplementationOnce(jest.fn());
    jest
      .spyOn(EventFactory.prototype, 'getCurrentCharacter')
      .mockReturnValueOnce(characters[0]);
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(GrpcAudioPlayback.prototype, 'excludeCurrentInteractionPackets')
      .mockImplementationOnce(() => [
        InworldPacket.fromProto({
          ...audioEvent,
          packetId: {
            packetId: audioEvent.packetId!.packetId,
            interactionId,
            utteranceId,
          },
        }),
      ]);

    await connection.send(() => textEvent);

    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(cancelResponse).toHaveBeenCalledTimes(1);
    expect(onInterruption).toHaveBeenCalledTimes(1);
    expect(onInterruption).toHaveBeenCalledWith({
      interactionId,
      utteranceId: [utteranceId],
    });
  });

  test('should add playback mute event to queue in case of auto reconnect', async () => {
    const open = jest.spyOn(ConnectionService.prototype, 'open');
    const write = jest
      .spyOn(WebSocketConnection.prototype, 'write')
      .mockImplementationOnce(writeMock);
    const wsOpen = jest
      .spyOn(WebSocketConnection.prototype, 'open')
      .mockImplementationOnce(jest.fn());
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(ConnectionService.prototype, 'getTtsPlaybackAction')
      .mockImplementationOnce(() => TtsPlaybackAction.MUTE);

    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: '' } },
        capabilities: capabilitiesProps,
      },
      user,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    await connection.send(() => textEvent);

    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(wsOpen.mock.calls[0][0].packets?.length).toEqual(1);
    expect(
      wsOpen.mock.calls[0][0].packets[0].getPacket().control?.action,
    ).toEqual(ControlEventAction.TTS_PLAYBACK_MUTE);
  });

  test('should not add playback mute event to queue in case of manual reconnect', async () => {
    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: HOSTNAME }, autoReconnect: false },
        capabilities: capabilitiesProps,
      },
      user,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    const wsOpen = jest.spyOn(WebSocketConnection.prototype, 'open');

    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(ConnectionService.prototype, 'getTtsPlaybackAction')
      .mockImplementationOnce(() => TtsPlaybackAction.MUTE);

    await connection.open();
    await server.connected;

    expect(wsOpen.mock.calls[0][0].packets).toEqual(undefined);
  });
});

describe('onMessage', () => {
  let server: WS;
  let connection: ConnectionService;

  const HOSTNAME = 'localhost:1234';

  beforeEach(() => {
    server = new WS(`ws://${HOSTNAME}/v1/session/default`, {
      jsonProtocol: true,
    });

    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: HOSTNAME }, autoReconnect: false },
        capabilities: capabilitiesProps,
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      onInterruption,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    jest
      .spyOn(GrpcAudioPlayback.prototype, 'getPlaybackStream')
      .mockImplementation(jest.fn());
    jest
      .spyOn(
        GrpcWebRtcLoopbackBiDiSession.prototype,
        'getPlaybackLoopbackStream',
      )
      .mockImplementation(jest.fn());
    jest
      .spyOn(GrpcWebRtcLoopbackBiDiSession.prototype, 'startSession')
      .mockImplementation(jest.fn());
    jest
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(jest.fn());
  });

  afterEach(() => {
    server.close();
    WS.clean();
    connection.close();
  });

  test('should cancel responses for already interrupted interaction', async () => {
    const cancelResponse = jest.spyOn(EventFactory.prototype, 'cancelResponse');
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(GrpcAudioPlayback.prototype, 'excludeCurrentInteractionPackets')
      .mockImplementationOnce(() => [
        InworldPacket.fromProto({
          ...audioEvent,
          packetId: {
            ...textEvent.packetId,
          },
        }),
      ]);
    jest.spyOn(connection, 'isActive').mockImplementation(() => true);

    await connection.open();

    await server.connected;

    await connection.send(() => textEvent);

    server.send({ result: incomingTextEvent });

    expect(cancelResponse).toHaveBeenCalledTimes(2);
  });

  test('should interrupt on player text event', async () => {
    const cancelResponse = jest
      .spyOn(EventFactory.prototype, 'cancelResponse')
      .mockImplementationOnce(jest.fn());
    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(GrpcAudioPlayback.prototype, 'excludeCurrentInteractionPackets')
      .mockImplementationOnce(() => [
        InworldPacket.fromProto({
          ...audioEvent,
          packetId: {
            ...textEvent.packetId,
          },
        }),
      ]);

    await connection.open();
    await server.connected;

    server.send({ result: incomingTextEvent });

    expect(cancelResponse).toHaveBeenCalledTimes(0);
  });

  test('should display history on incoming audio event', async () => {
    connection = new ConnectionService({
      name: SCENE,
      config: {
        connection: { gateway: { hostname: HOSTNAME }, autoReconnect: false },
        capabilities: capabilitiesProps,
      },
      user,
      onError,
      onMessage,
      onDisconnect,
      onHistoryChange: () => {
        expect(onMessage).toHaveBeenCalledTimes(1);
      },
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene));
    jest
      .spyOn(InworldHistory.prototype, 'display')
      .mockImplementationOnce(() => [{} as HistoryItem, {} as HistoryItem]);
    jest
      .spyOn(InworldHistory.prototype, 'addOrUpdate')
      .mockImplementationOnce(() => []);

    await connection.open();

    await server.connected;

    server.send({ result: audioEvent });
  });
});

describe('loadCharacters', () => {
  test("should load scene if it's required", async () => {
    const getCurrentCharacter = jest.spyOn(
      EventFactory.prototype,
      'getCurrentCharacter',
    );
    const setCurrentCharacter = jest.spyOn(
      EventFactory.prototype,
      'setCurrentCharacter',
    );
    const generateSessionToken = jest.fn(() => Promise.resolve(session));

    const connection = new ConnectionService({
      name: SCENE,
      config: { capabilities: capabilitiesProps },
      user,
      onError,
      onMessage,
      onDisconnect,
      grpcAudioPlayer,
      generateSessionToken,
      webRtcLoopbackBiDiSession,
    });

    const loadScene = jest
      .spyOn(WorldEngineService.prototype, 'loadScene')
      .mockImplementationOnce(() => Promise.resolve(scene))
      .mockImplementationOnce(() => Promise.resolve(scene));
    const setCharacters = jest.spyOn(EventFactory.prototype, 'setCharacters');

    await connection.loadCharacters();
    await connection.loadCharacters();

    expect(setCharacters).toHaveBeenCalledTimes(1);
    expect(setCharacters).toHaveBeenCalledWith(characters);
    expect(generateSessionToken).toHaveBeenCalledTimes(1);
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(setCurrentCharacter).toHaveBeenCalledTimes(1);
    expect(getCurrentCharacter).toHaveBeenCalledTimes(1);
  });
});
