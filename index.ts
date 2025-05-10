import { randomUUIDv7, type ServerWebSocket } from "bun";
import type { IncomingMessage, SignupIncomingMessage } from "./types";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import nacl_util from "tweetnacl-util";
import prisma from "./prisma";
import { AirStatus } from "@prisma/client";
interface RequestPlacesMessage {
  type: 'request_places';
  data: {
    callbackId: string;
  };
}

interface ValidateRequestMessage {
  type: 'validate';
  data: {
    placeId: string;
    lat: number;
    lng: number;
    callbackId: string;
    placeName?: string;
  };
}

interface ValidateResponseMessage {
  type: 'validate';
  data: {
    validatorId: string;
    signedMessage: number[];
    aqi: number;
    pm25: number;
    pm10: number;
    co: number;
    no: number;
    so2: number;
    nh3: number;
    no2: number;
    o3: number;
    callbackId: string;
  };
}

type WebSocketMessage = IncomingMessage | RequestPlacesMessage | ValidateRequestMessage | ValidateResponseMessage;

const availableValidators: { validatorId: string, socket: ServerWebSocket<unknown>, publicKey: string }[] = [];

const CALLBACKS : { [callbackId: string]: (data: ValidateResponseMessage) => void } = {}
const COST_PER_VALIDATION = 100; // in lamports

async function verifyMessage(message: string, publicKey: string, signature: number[] | string) {
    const messageBytes = nacl_util.decodeUTF8(message);
    const signatureBytes = typeof signature === 'string' ? JSON.parse(signature) : signature;
    const result = nacl.sign.detached.verify(
        messageBytes,
        new Uint8Array(signatureBytes),
        new PublicKey(publicKey).toBytes(),
    );

    return result;
}

Bun.serve({
    fetch(req, server) {
      if (server.upgrade(req)) {
        return;
      }
      return new Response("Upgrade failed", { status: 500 });
    },
    port: 8081,
    websocket: {
        async message(ws: ServerWebSocket<unknown>, message: string) {
            const data: WebSocketMessage = JSON.parse(message);
            
            if (data.type === 'signup') {
                const verified = await verifyMessage(
                    `Signed message for ${data.data.callbackId}, ${data.data.publicKey}`,
                    data.data.publicKey,
                    data.data.signedMessage
                );
                if (verified) {
                    await signupHandler(ws, data.data);
                }
            } else if (data.type === 'validate') {
                if ('validatorId' in data.data) {
                    const responseData = data as ValidateResponseMessage;
                    CALLBACKS[responseData.data.callbackId]?.(responseData);
                    delete CALLBACKS[responseData.data.callbackId];
                } else {
                    const requestData = data as ValidateRequestMessage;
                    const validator = availableValidators.find(v => v.socket === ws);
                    if (!validator) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: {
                                message: 'Validator not found. Please sign up first.',
                                callbackId: requestData.data.callbackId
                            }
                        }));
                        return;
                    }

                    const placesToValidate = await prisma.place.findMany({
                        where: {
                            disabled: false,
                            airQuality: {
                                is: null,
                            },
                            validatorFetching: false,
                        },
                    });

                    if (placesToValidate.length === 0) {
                        ws.send(JSON.stringify({
                            type: 'no_places',
                            data: {
                                callbackId: requestData.data.callbackId
                            }
                        }));
                        return;
                    }

                    placesToValidate.forEach((place: any) => {
                        const callbackId = randomUUIDv7();
                        ws.send(JSON.stringify({
                            type: 'validate',
                            data: {
                                placeId: place.id,
                                lat: place.latitude,
                                lng: place.longitude,
                                placeName: place.placeName,
                                callbackId
                            }
                        }));

                        prisma.place.update({
                            where: {
                                id: place.id,
                            },
                            data: {
                                validatorFetching: true,
                            }
                        }).catch(console.error);
                    });
                }
            } else if (data.type === 'request_places') {
                console.log("request_places", data.data)
                const requestData = data as RequestPlacesMessage;
                const validator = availableValidators.find(v => v.socket === ws);
                if (!validator) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: {
                            message: 'Validator not found. Please sign up first.',
                            callbackId: requestData.data.callbackId
                        }
                    }));
                    return;
                }

                const placesToValidate = await prisma.place.findMany({
                    where: {
                        disabled: false,
                        airQuality: {
                            is: null,
                        },
                        validatorFetching: false,
                    },
                    take: 10,
                });
                console.log("placesToValidate", placesToValidate)

                if (placesToValidate.length === 0) {
                    ws.send(JSON.stringify({
                        type: 'no_places',
                        data: {
                            callbackId: requestData.data.callbackId
                        }
                    }));
                    return;
                }
                console.log("have palces to validate")

                placesToValidate.forEach((place: any) => {
                    const callbackId = randomUUIDv7();
                    ws.send(JSON.stringify({
                        type: 'validate',
                        data: {
                            placeId: place.id,
                            lat: place.latitude,
                            lng: place.longitude,
                            placeName: place.placeName,
                            callbackId
                        }
                    }));

                    CALLBACKS[callbackId] = async (data: ValidateResponseMessage) => {
                        if (data.type === 'validate') {
                            console.log(`Received validate from ${validator.validatorId} ${place.placeName}`);
                            const { validatorId, signedMessage, aqi, pm25, pm10, co, no, so2, nh3, no2, o3 } = data.data;
                            console.log("data.data", data.data);
                            const verified = await verifyMessage(
                                `Replying to ${callbackId}`,
                                validator.publicKey,
                                signedMessage
                            );
                            if (!verified) {
                                return;
                            }
        
                            await prisma.$transaction(async (tx: any) => {
        
                                await tx.place.update({
                                    where: {
                                        id: place.id,
                                    },
                                    data: {
                                        validatedByWallet: validator.publicKey,
                                        validatorFetching: false,
                                    }
                                });
        
                                await tx.airQuality.create({
                                    data: {
                                        placeId: place.id,
                                        place: {
                                            connect: {
                                                id: place.id,
                                            },
                                        },
                                        aqi,
                                        pm25,
                                        pm10,
                                        co,
                                        no,
                                        so2,
                                        nh3,
                                        no2,
                                        o3,
                                        status: aqi === 1 ? AirStatus.GOOD : aqi === 2 ? AirStatus.MODERATE : aqi === 3 ? AirStatus.UNHEALTHY : aqi === 4 ? AirStatus.VERY_UNHEALTHY : AirStatus.SEVERE,
                                    },
                                });
        
                                await tx.validator.update({
                                    where: {
                                        walletAddress: validatorId
                                    },
                                    data: {
                                        pendingPayouts: { increment: COST_PER_VALIDATION },
                                    },
                                });
                            });
                        }
                    };
                });
            }
        },
        async close(ws: ServerWebSocket<unknown>) {
            availableValidators.splice(availableValidators.findIndex(v => v.socket === ws), 1);
        }
    },
});

async function signupHandler(ws: ServerWebSocket<unknown>, { publicKey, signedMessage, callbackId }: SignupIncomingMessage) {
    const validatorDb = await prisma.validator.findFirst({
        where: {
            walletAddress: publicKey,
        },
    });

    if (validatorDb) {
        ws.send(JSON.stringify({
            type: 'signup',
            data: {
                validatorId: validatorDb.id,
                callbackId,
            },
        }));

        availableValidators.push({
            validatorId: validatorDb.id,
            socket: ws,
            publicKey: validatorDb.walletAddress,
        });
        return;
    }
    
    const validator = await prisma.validator.create({
        data: {
            walletAddress: publicKey,
        },
    });

    ws.send(JSON.stringify({
        type: 'signup',
        data: {
            validatorId: validator.id,
            callbackId,
        },
    }));

    availableValidators.push({
        validatorId: validator.id,
        socket: ws,
        publicKey: validator.walletAddress,
    });
}

const callCallBack = (callbackId: string, data: ValidateResponseMessage) => {
    CALLBACKS[callbackId]?.(data);
    delete CALLBACKS[callbackId];
}

setInterval(async () => {
    const placesToGetAirQuality = await prisma.place.findMany({
        where: {
            disabled: false,
            airQuality: {
                is: null,
            },
        },
    });
    console.log(`Found ${placesToGetAirQuality.length} places to get air quality for`);

    for (const place of placesToGetAirQuality) {
        console.log("availableValidators", availableValidators);
        availableValidators.forEach(async (validator) => {
            const callbackId = randomUUIDv7();
            console.log(`Sending validate to ${validator.validatorId} ${place.placeName}`);
            validator.socket.send(JSON.stringify({
                type: 'validate',
                data: {
                    placeName: place.placeName,
                    placeId: place.id,
                    lat: place.latitude,
                    lng: place.longitude,
                    callbackId
                },
            }));

            await prisma.place.update({
                where: {
                    id: place.id,
                },
                data: {
                    validatedByWallet: validator.publicKey,
                    validatorFetching: true,
                }
            });

            CALLBACKS[callbackId] = async (data: ValidateResponseMessage) => {
                if (data.type === 'validate') {
                    console.log(`Received validate from ${validator.validatorId} ${place.placeName}`);
                    const { validatorId, signedMessage, aqi, pm25, pm10, co, no, so2, nh3, no2, o3 } = data.data;
                    console.log("data.data", data.data);
                    const verified = await verifyMessage(
                        `Replying to ${callbackId}`,
                        validator.publicKey,
                        signedMessage
                    );
                    if (!verified) {
                        return;
                    }

                    await prisma.$transaction(async (tx: any) => {

                        await tx.place.update({
                            where: {
                                id: place.id,
                            },
                            data: {
                                validatedByWallet: validator.publicKey,
                                validatorFetching: false,
                            }
                        });

                        await tx.airQuality.create({
                            data: {
                                placeId: place.id,
                                place: {
                                    connect: {
                                        id: place.id,
                                    },
                                },
                                aqi,
                                pm25,
                                pm10,
                                co,
                                no,
                                so2,
                                nh3,
                                no2,
                                o3,
                                status: aqi === 1 ? AirStatus.GOOD : aqi === 2 ? AirStatus.MODERATE : aqi === 3 ? AirStatus.UNHEALTHY : aqi === 4 ? AirStatus.VERY_UNHEALTHY : AirStatus.SEVERE,
                            },
                        });

                        await tx.validator.update({
                            where: {
                                walletAddress: validatorId
                            },
                            data: {
                                pendingPayouts: { increment: COST_PER_VALIDATION },
                            },
                        });
                    });
                }
            };
        });
    }
}, 60 * 1000);