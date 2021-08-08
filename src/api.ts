import { PlatformAccessory, Logging } from 'homebridge';
import { GoogleNestPlatform } from './platform';
import { smartdevicemanagement_v1 } from 'googleapis';
import { Mutex, withTimeout } from 'async-mutex';
import { GoogleNestThermostatCharacteristics } from './characteristics';

const seconds = (x: number) => {
  return x * 1000;
};

class Timeout {
  private cache = seconds(5);
  private value = this.cache;

  reset() {
    this.value = this.cache;
  }

  offline() {
    this.value = seconds(30);
  }

  get() {
    return this.value;
  }
}

export interface GoogleNestThermostatUpdateHandler {
  onDisplayUnit(unit: 'FAHRENHEIT' | 'CELSIUS'): void;
}

const deviceToTraits = (device: smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device) => {
  const connectivity = device.traits?.['sdm.devices.traits.Connectivity']?.status;
  const ecoMode = device.traits?.['sdm.devices.traits.ThermostatEco']?.mode;
  const currentTemperature = device.traits?.['sdm.devices.traits.Temperature']?.['ambientTemperatureCelsius'];
  const hvacStatus = device.traits?.['sdm.devices.traits.ThermostatHvac']?.status;
  const targetMode = device.traits?.['sdm.devices.traits.ThermostatMode']?.mode;
  const availableTargetModes = device.traits?.['sdm.devices.traits.ThermostatMode']?.availableModes;
  const displayUnit = device.traits?.['sdm.devices.traits.Settings']?.temperatureScale;
  const temperatureSetpoint = device.traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint'];
  const relativeHumidity = device.traits?.['sdm.devices.traits.Humidity']?.ambientHumidityPercent;
  return {
    connectivity,
    ecoMode,
    currentTemperature,
    hvacStatus,
    targetMode,
    availableTargetModes,
    displayUnit,
    temperatureSetpoint,
    relativeHumidity,
  };
};

type Traits = ReturnType<typeof deviceToTraits>;

export class GoogleNestThermostatApi {
  private log: Logging = this.platform.log;
  private timeout = new Timeout();
  private fetchMutex = withTimeout(new Mutex(), 500,
    new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY));

  private cache: {
    traits: Traits | null;
    characrestics: GoogleNestThermostatCharacteristics | null;
    timestamp: number;
  } = {
    traits: null,
    characrestics: null,
    timestamp: Date.now(),
  };

  constructor(
    private readonly platform: GoogleNestPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly gapi: smartdevicemanagement_v1.Smartdevicemanagement,
    private readonly updateHandler: GoogleNestThermostatUpdateHandler,
  ) { }

  private save(traits: Traits) {
    if (this.cache.traits?.displayUnit !== traits.displayUnit && traits.displayUnit) {
      this.updateHandler.onDisplayUnit(traits.displayUnit);
    }
    this.cache.traits = traits;
    this.cache.characrestics = new GoogleNestThermostatCharacteristics(this.cache.traits, (msg: string) => {
      this.log.error(msg);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    });
    this.cache.timestamp = Date.now();
  }

  async fetch(): Promise<GoogleNestThermostatCharacteristics> {
    const release = await this.fetchMutex.acquire();
    try {
      if (this.cache.traits && Date.now() - this.cache.timestamp <= this.timeout.get()) {
        if (this.cache.traits?.connectivity === 'OFFLINE') {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.cache.characrestics!;
      }

      const res = await this.gapi.enterprises.devices.get({
        name: this.accessory.context.name,
      });

      if (res.status === 200) {
        this.save(deviceToTraits(res.data));
      } else {
        this.log.error('fetchState() failed, response:', JSON.stringify(res));
        if (!this.cache.traits) {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      }
    } finally {
      release();
    }

    if (this.cache.traits?.connectivity === 'OFFLINE') {
      this.log.warn('Device is OFFLINE.');
      this.timeout.offline();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.timeout.reset();
    return this.cache.characrestics!;
  }

  async executeCommand(command: string, params) {
    const res = await this.gapi.enterprises.devices.executeCommand({
      name: this.accessory.context.name,
      requestBody: {
        command,
        params,
      },
    });

    if (res.status !== 200) {
      this.log.error('handleTargetHeatingCoolingStateSet failed, response:', JSON.stringify(res));
    }
  }

}
