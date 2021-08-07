import { Service, PlatformAccessory, CharacteristicValue, Logging, HAPStatus } from 'homebridge';
import { GoogleNestPlatform } from './platform';
import { smartdevicemanagement_v1 } from 'googleapis';
import { Mutex } from 'async-mutex';

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

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class GoogleNestThermostat {
  private service: Service;
  private ecoService: Service;
  private timeout = new Timeout();
  private fetchMutex = new Mutex();
  private log: Logging = this.platform.log;
  private C = this.platform.Characteristic;

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
    this.state.timestamp = Date.now();
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, 'Google Nest')
      .setCharacteristic(this.C.Model, 'Thermostat')
      .setCharacteristic(this.C.SerialNumber, 'Unknown');

    this.service = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    this.service.getCharacteristic(this.C.TargetHeatingCoolingState).setProps({
      validValues: [
        this.C.TargetHeatingCoolingState.OFF, this.C.TargetHeatingCoolingState.HEAT,
        this.C.TargetHeatingCoolingState.COOL, this.C.TargetHeatingCoolingState.AUTO],
    });

    // create handlers for required characteristics
    this.service.getCharacteristic(this.C.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(this.C.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service.getCharacteristic(this.C.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.C.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.service.getCharacteristic(this.C.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    this.service.getCharacteristic(this.C.CoolingThresholdTemperature)
      .onGet(this.handleCoolingThresholdTemperatureGet.bind(this))
      .onSet(this.handleCoolingThresholdTemperatureSet.bind(this));

    this.service.getCharacteristic(this.C.HeatingThresholdTemperature)
      .onGet(this.handleHeatingThresholdTemperatureGet.bind(this))
      .onSet(this.handleHeatingThresholdTemperatureSet.bind(this));

    this.service.getCharacteristic(this.C.CurrentRelativeHumidity)
      .onGet(this.handleCurrentRelativeHumidityGet.bind(this));

    this.service.getCharacteristic(this.C.Name)
      .onGet(this.handleNameGet.bind(this));

    this.ecoService = this.accessory.getService('Eco Mode')
      || this.accessory.addService(this.platform.Service.Switch, 'Eco Mode', 'eco_mode_0');

    this.ecoService.getCharacteristic(this.C.On)
      .onGet(this.handleEcoSwitchGet.bind(this))
      .onSet(this.handleEcoSwitchSet.bind(this));
  }

  private isOffline(): boolean {
    return this.state.data?.traits?.['sdm.devices.traits.Connectivity']?.status === 'OFFLINE';
  }

  private updateTempRanges(res: smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device) {
    this.log.debug('udpateTempRanges');
    const tempStep = 0.1;
    const f2c = (temp: number) => {
      return (temp - 32) / 1.8;
    };
    const [minSetTemp, maxSetTemp, minGetTemp, maxGetTemp] =
      this.getDisplayUnit(res) === 'FAHRENHEIT' ? [f2c(50), f2c(90), f2c(0), f2c(160)] :
        [10, 32, -20, 60];
    this.service.getCharacteristic(this.C.CurrentTemperature).setProps({
      minStep: tempStep,
      minValue: minGetTemp,
      maxValue: maxGetTemp,
    });
    this.service.getCharacteristic(this.C.TargetTemperature).setProps({
      minStep: tempStep,
      minValue: minSetTemp,
      maxValue: maxSetTemp,
    });
    this.service.getCharacteristic(this.C.CoolingThresholdTemperature).setProps({
      minStep: tempStep,
      minValue: minSetTemp,
      maxValue: maxSetTemp,
    });
    this.service.getCharacteristic(this.C.HeatingThresholdTemperature).setProps({
      minStep: tempStep,
      minValue: minSetTemp,
      maxValue: maxSetTemp,
    });
  }

  private commitState(res: smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device) {
    if (!this.state.data || this.getDisplayUnit() !== this.getDisplayUnit(res)) {
      this.updateTempRanges(res);
    }
    this.state.data = res;
    this.state.timestamp = Date.now();
  }

  async fetchState() {
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

      if (res.status === 200) {
        this.commitState(res.data);
      } else {
        this.log.error('fetchState() failed, response:', JSON.stringify(res));
      }
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

  private getDisplayUnit(data = this.state.data): 'FAHRENHEIT' | 'CELSIUS' {
    const unit = data?.traits?.['sdm.devices.traits.Settings']?.['temperatureScale'];
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

  private getHumidity(): number {
    const humidity = this.state.data?.traits?.['sdm.devices.traits.Humidity'];
    if (!humidity) {
      this.throwTraitError('getHumidity failed to get setpoint, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return humidity.ambientHumidityPercent!;
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
    await this.fetchState();

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
    await this.fetchState();

    const targetMode = this.getTargetMode();

    this.log.debug('GET TargetHeatingCoolingState', targetMode);
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

    await this.fetchState();

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
    this.log.debug('SET TargetHeatingCoolingState', mode);
    if (!this.getAvailableTargetModes().includes(mode)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }

    await this.executeCommand('sdm.devices.commands.ThermostatMode.SetMode', {
      mode,
    });
  }

  async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    await this.fetchState();
    this.log.debug('GET CurrentTemperature', this.getCurrentTemperature());
    return this.getCurrentTemperature();
  }

  async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    await this.fetchState();

    const setpoint = this.getTemperatureSetpoint();
    const heat = setpoint['heatCelsius'];
    const cool = setpoint['coolCelsius'];

    this.log.debug('GET TargetTemperature', JSON.stringify(setpoint));
    if (!heat && !cool) {
      this.throwTraitError('handleTargetTemperatureGet failed to get heat or cool, state: ' + JSON.stringify(this.state),
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    if (heat && !cool) {
      return heat;
    } else if (!heat && cool) {
      return cool;
    } else {
      return this.getCurrentTemperature();
    }
  }

  async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TargetTemperature:', value);
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
  }

  async handleTemperatureDisplayUnitsGet(): Promise<CharacteristicValue> {
    await this.fetchState();

    const displayUnit = this.getDisplayUnit();
    this.log.debug('GET TemperatureDisplayUnit', displayUnit);
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
    await this.fetchState();

    const setpoint = this.getTemperatureSetpoint();

    this.log.debug('GET CoolingThresholdTemperature', setpoint);
    if (!setpoint.coolCelsius) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return setpoint.coolCelsius;
  }

  async handleCoolingThresholdTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET CoolingThresholdTemperature:', value);
    await this.fetchState();

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
    await this.fetchState();

    const setpoint = this.getTemperatureSetpoint();

    this.log.debug('GET HeatingThresholdTemperature', setpoint);
    if (!setpoint.heatCelsius) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    return setpoint.heatCelsius;
  }

  async handleHeatingThresholdTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET HeatingThresholdTemperature:', value);
    await this.fetchState();

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
    await this.fetchState();
    this.log.debug('GET EcoSwitch', this.getEcoMode());
    return this.getEcoMode() === 'MANUAL_ECO';
  }

  async handleEcoSwitchSet(value: CharacteristicValue) {
    this.log.info('Triggered SET EchoSwtich:', value);
    await this.executeCommand('sdm.devices.commands.ThermostatEco.SetMode', {
      mode: value ? 'MANUAL_ECO' : 'OFF',
    });
  }

  async handleCurrentRelativeHumidityGet(): Promise<CharacteristicValue> {
    await this.fetchState();
    this.log.debug('GET CurrentRelativeHumidity', this.getHumidity);
    return this.getHumidity();
  }

  async handleNameGet(): Promise<CharacteristicValue> {
    this.log.debug('GET Name', 'Google Nest Thermostat');
    return 'Google Nest Thermostat';
  }
}
