import { PlatformAccessory, Logging } from 'homebridge';
import { GoogleNestPlatform } from './platform';
import { smartdevicemanagement_v1 } from 'googleapis';
import { Mutex, withTimeout } from 'async-mutex';
import { GoogleNestThermostatCharacteristics } from './characteristics';

const seconds = (x: number) => {
  return x * 1000;
};

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

type DeviceTraits = ReturnType<typeof deviceToTraits>;

class Cache {
  private traits?: DeviceTraits;
  private characrestics?: GoogleNestThermostatCharacteristics;

  private timestamp: number = Date.now();
  private timeout = seconds(5);

  constructor(
    private readonly error: () => never,
  ) {}

  getTraits() {
    return this.traits;
  }

  getCharacrestics(): GoogleNestThermostatCharacteristics {
    if (!this.characrestics) {
      this.error();
    }

    return this.characrestics;
  }

  set(traits: DeviceTraits, characteristics?: GoogleNestThermostatCharacteristics) {
    this.traits = traits;
    this.characrestics = characteristics;
    this.timestamp = Date.now();
  }

  isAlive(): boolean {
    return this.traits !== null && (Date.now() - this.timestamp) <= this.timeout;
  }
}

export class GoogleNestThermostatApi {
  private log: Logging = this.platform.log;
  private fetchMutex = withTimeout(new Mutex(), 500,
    new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY));

  private cache = new Cache(() => {
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  constructor(
    private readonly platform: GoogleNestPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly gapi: smartdevicemanagement_v1.Smartdevicemanagement,
    private readonly updateHandler: GoogleNestThermostatUpdateHandler,
  ) {}

  private save(traits: DeviceTraits) {
    if (this.cache.getTraits()?.displayUnit !== traits.displayUnit && traits.displayUnit) {
      this.updateHandler.onDisplayUnit(traits.displayUnit);
    }

    if (traits.connectivity === 'OFFLINE') {
      this.cache.set(traits);
    } else {
      this.cache.set(traits, new GoogleNestThermostatCharacteristics(traits, (msg: string) => {
        this.log.error(msg);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
      }));
    }
  }

  async fetch(): Promise<GoogleNestThermostatCharacteristics> {
    const release = await this.fetchMutex.acquire();
    try {
      if (this.cache.isAlive()) {
        return this.cache.getCharacrestics();
      }

      const res = await this.gapi.enterprises.devices.get({
        name: this.accessory.context.name,
      });

      if (res.status === 200) {
        this.save(deviceToTraits(res.data));
      } else {
        this.log.error('fetchState() failed, response:', JSON.stringify(res));
        if (!this.cache.getTraits()) {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      }
    } finally {
      release();
    }

    return this.cache.getCharacrestics();
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
