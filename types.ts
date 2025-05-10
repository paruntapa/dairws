export interface SignupIncomingMessage {
    publicKey: string;
    signedMessage: string;
    callbackId: string;
}

export interface ValidateIncomingMessage {
    validatorId: string;
    callbackId: string;
    placeId: string;
    signedMessage: string;
    aqi: number;
    pm25: number;
    pm10: number;
    co: number;
    no: number;
    so2: number;
    nh3: number;
    no2: number;
    o3: number;
}

export interface SignupOutgoingMessage {
    validatorId: string;
    callbackId: string;
}

export interface ValidateOutgoingMessage {
    lat: number;
    lng: number;
    placeId: string;
    callbackId: string,
}

export interface AirStatus {
    aqi: number;
    pm25: number;
    pm10: number;
    co: number;
    no: number;
    so2: number;
    nh3: number;
}

export type IncomingMessage = {
    type: 'signup'
    data: SignupIncomingMessage
} | {
    type: 'validate'
    data: ValidateIncomingMessage
}

export type OutgoingMessage = {
    type: 'signup'
    data: SignupOutgoingMessage
} | {
    type: 'validate'
    data: ValidateOutgoingMessage
}