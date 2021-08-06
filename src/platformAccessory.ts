import { Service, PlatformAccessory, CharacteristicValue, Logging, HAPStatus } from 'homebridge';
import { GoogleNestPlatform } from './platform';
import { smartdevicemanagement_v1 } from 'googleapis';
import { Mutex } from 'async-mutex';

const seconds = (x: number) => {
  return x * 1000;
};

class Timeout {
  private cache = seconds(1);
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

const MAX_COOL_TEMP = 35;
const MIN_HEAT_TEMP = 0;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class GoogleNestThermostat {
  private service: Service;
  private ecoService: Service;
  private log: Logging;
  private timeout = new Timeout();
  private fetchMutex = new Mutex();



  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private state: {
    data: smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device | null;
    timestamp: number;
  } = {
    data: null,
    timestamp: 0,
  };

  constructor(
    private readonly platform: GoogleNestPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly gapi: smartdevicemanagement_v1.Smartdevicemanagement,
  ) {
    this.log = platform.log;

    const C = this.platform.Characteristic;
    this.state.timestamp = Date.now();
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Google Nest')
      .setCharacteristic(C.Model, 'Thermostat')
      .setCharacteristic(C.SerialNumber, 'Unknown');

    this.service = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    // create handlers for required characteristics
    this.service.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(C.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service.getCharacteristic(C.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(C.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.service.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    this.service.getCharacteristic(C.CoolingThresholdTemperature)
      .onGet(this.handleCoolingThresholdTemperatureGet.bind(this))
      .onSet(this.handleCoolingThresholdTemperatureSet.bind(this));

    this.service.getCharacteristic(C.HeatingThresholdTemperature)
      .onGet(this.handleHeatingThresholdTemperatureGet.bind(this))
      .onSet(this.handleHeatingThresholdTemperatureSet.bind(this));

    this.ecoService = this.accessory.getService('Eco Mode')
      || this.accessory.addService(this.platform.Service.Switch, 'Eco Mode', 'eco_mode_0');

    this.ecoService.getCharacteristic(C.On)
      .onGet(this.handleEcoSwitchGet.bind(this))
      .onSet(this.handleEcoSwitchSet.bind(this));
  }

  private isOffline(): boolean {
    return this.state.data?.traits?.['sdm.devices.traits.Connectivity']?.status === 'OFFLINE';
  }

  async fetchStates() {
    const release = await this.fetchMutex.acquire();
    try {
      if (this.state.data && Date.now() - this.state.timestamp <= this.timeout.get()) {
        if (this.isOffline()) {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return;
      }

      const res = await this.gapi.enterprises.devices.get({
        name: this.accessory.context.name,
      });
      this.state.timestamp = Date.now();
      this.state.data = res.data;
    } finally {
      release();
    }

    if (this.isOffline()) {
      this.log.warn('Device is OFFLINE.');
      this.timeout.offline();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.timeout.reset();
  }

  private throwTraitError(msg: string, code: HAPStatus): never {
    this.log.error(msg);
    throw new this.platform.api.hap.HapStatusError(code);
  }

  private getHvacStatus(): 'COOLING' | 'HEATING' | 'OFF' {
    const hvac = this.state.data?.traits?.['sdm.devices.traits.ThermostatHvac'];
    if (!hvac) {
      this.throwTraitError('getHvacStatus() failed, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return hvac.status;
  }

  private getEcoMode(): 'MANUAL_ECO' | 'OFF' {
    const eco = this.state.data?.traits?.['sdm.devices.traits.ThermostatEco'];

    if (!eco) {
      this.throwTraitError('getEcoMode() failed, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return eco.mode;
  }

  private getCurrentTemperature(): number {
    const temp = this.state.data?.traits?.['sdm.devices.traits.Temperature']?.['ambientTemperatureCelsius'];
    if (!temp) {
      this.throwTraitError('getCurrentTemperature() failed, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return temp;
  }

  private getTargetMode(): 'HEAT' | 'COOL' | 'HEATCOOL' | 'OFF' {
    const target = this.state.data?.traits?.['sdm.devices.traits.ThermostatMode'];
    if (!target) {
      this.throwTraitError('getTargetMode() failed, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return target.mode;
  }

  private getAvailableTargetModes(): string[] {
    const target = this.state.data?.traits?.['sdm.devices.traits.ThermostatMode'];
    if (!target) {
      this.throwTraitError('getAvailableTargetMode() failed, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return target.availableModes;
  }

  private getDisplayUnit(): 'FAHRENHEIT' | 'CELSIUS' {
    const unit = this.state.data?.traits?.['sdm.devices.traits.Settings']?.['temperatureScale'];
    if (!unit) {
      this.throwTraitError('getDisplayUnit() failed, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return unit;
  }

  private getTemperatureSetpoint(): { 'heatCelsius'?: number; 'coolCelsius'?: number } {
    const setpoint = this.state.data?.traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint'];
    if (!setpoint) {
      this.throwTraitError('getTemperatureSetpoint failed to get setpoint, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return setpoint;
  }

  private async executeCommand(command: string, params) {
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

  async handleCurrentHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    await this.fetchStates();

    const status = this.getHvacStatus();
    if (status === 'HEATING') {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    } else if (status === 'COOLING') {
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    } else {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    await this.fetchStates();

    const targetMode = this.getTargetMode();

    if (targetMode === 'HEAT') {
      return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    } else if (targetMode === 'COOL') {
      return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    } else if (targetMode === 'HEATCOOL') {
      return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    } else {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  async handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TargetHeatingCoolingState:', value);

    await this.fetchStates();

    if (this.getEcoMode() === 'MANUAL_ECO') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    const valueToMode = (value: CharacteristicValue) => {
      switch (value) {
        case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
          return 'HEAT';
        case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
          return 'COOL';
        case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
          return 'HEATCOOL';
        default:
          return 'OFF';
      }
    };

    const mode = valueToMode(value);
    if (!this.getAvailableTargetModes().includes(mode)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }

    await this.executeCommand('sdm.devices.commands.ThermostatMode.SetMode', {
      mode,
    });
  }

  async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    await this.fetchStates();
    return this.getCurrentTemperature();
  }

  async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    await this.fetchStates();

    const status = this.getHvacStatus();
    const temp = this.getCurrentTemperature();
    if (status === 'OFF') {
      return temp;
    }

    const setpoint = this.getTemperatureSetpoint();
    const heat = setpoint['heatCelsius'];
    const cool = setpoint['coolCelsius'];

    if (!heat && !cool) {
      this.throwTraitError('handleTargetTemperatureGet failed to get heat or cool, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    if (heat && !cool) {
      return heat;
    } else if (!heat && cool) {
      return cool;
    } else {
      return Math.abs(temp - heat!) < Math.abs(temp - cool!) ? heat! : cool!;
    }
  }

  async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TargetTemperature:', value);
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
  }

  async handleTemperatureDisplayUnitsGet(): Promise<CharacteristicValue> {
    await this.fetchStates();

    const displayUnit = this.getDisplayUnit();
    if (displayUnit === 'FAHRENHEIT') {
      return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    } else {
      return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    }
  }

  async handleTemperatureDisplayUnitsSet(value: CharacteristicValue) {
    this.log.error('Triggered unsupported SET TargetTemperature:', value);
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
  }

  async handleCoolingThresholdTemperatureGet(): Promise<CharacteristicValue> {
    await this.fetchStates();

    return this.getTemperatureSetpoint().coolCelsius ?? MAX_COOL_TEMP;
  }

  async handleCoolingThresholdTemperatureSet(value: CharacteristicValue) {
    await this.fetchStates();

    if (this.getEcoMode() === 'MANUAL_ECO') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    const mode = this.getTargetMode();
    if (mode !== 'COOL' && mode !== 'HEATCOOL') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    if (mode === 'COOL') {
      await this.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', {
        coolCelsius: value,
      });
    } else {
      await this.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange', {
        heatCelsius: this.getTemperatureSetpoint().heatCelsius,
        coolCelsius: value,
      });
    }
  }

  async handleHeatingThresholdTemperatureGet(): Promise<CharacteristicValue> {
    await this.fetchStates();

    return this.getTemperatureSetpoint().heatCelsius ?? MIN_HEAT_TEMP;
  }

  async handleHeatingThresholdTemperatureSet(value: CharacteristicValue) {
    await this.fetchStates();

    if (this.getEcoMode() === 'MANUAL_ECO') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    const mode = this.getTargetMode();
    if (mode !== 'HEAT' && mode !== 'HEATCOOL') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    if (mode === 'HEAT') {
      await this.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat', {
        heatCelsius: value,
      });
    } else {
      await this.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange', {
        heatCelsius: value,
        coolCelsius: this.getTemperatureSetpoint().coolCelsius,
      });
    }
  }

  async handleEcoSwitchGet(): Promise<CharacteristicValue> {
    await this.fetchStates();
    return this.getEcoMode() === 'MANUAL_ECO';
  }

  async handleEcoSwitchSet(value: CharacteristicValue) {
    await this.executeCommand('sdm.devices.commands.ThermostatEco.SetMode', {
      mode: value ? 'MANUAL_ECO' : 'OFF',
    });
  }
}
