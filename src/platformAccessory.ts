import { Service, PlatformAccessory, CharacteristicValue, Logging, Characteristic } from 'homebridge';
import { smartdevicemanagement_v1 } from 'googleapis';
import { GoogleNestPlatform } from './platform';
import { GoogleNestThermostatApi, GoogleNestThermostatUpdateHandler } from './api';

class CharacresticsUpdateHandler implements GoogleNestThermostatUpdateHandler {
  constructor(
    private readonly service: Service,
    private readonly C: typeof Characteristic,
  ) {}

  onDisplayUnit(unit: 'FAHRENHEIT' | 'CELSIUS') {
    const tempStep = 0.1;
    const f2c = (temp: number) => {
      return (temp - 32) / 1.8;
    };
    const [minSetTemp, maxSetTemp, minGetTemp, maxGetTemp] =
      unit === 'FAHRENHEIT' ? [f2c(50), f2c(90), f2c(0), f2c(160)] :
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
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class GoogleNestThermostatHandler {
  private api: GoogleNestThermostatApi;
  private log: Logging = this.platform.log;
  private C = this.platform.Characteristic;

  private service: Service =
    this.accessory.getService(this.platform.Service.Thermostat)
    || this.accessory.addService(this.platform.Service.Thermostat);

  private ecoService: Service =
    this.accessory.getService('Eco Mode')
    || this.accessory.addService(this.platform.Service.Switch, 'Eco Mode', 'eco_mode_0');

  constructor(
    private readonly platform: GoogleNestPlatform,
    private readonly accessory: PlatformAccessory,
    gapi: smartdevicemanagement_v1.Smartdevicemanagement,
  ) {
    this.api = new GoogleNestThermostatApi(this.platform, this.accessory, gapi, new CharacresticsUpdateHandler(this.service, this.C));

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, 'Google Nest')
      .setCharacteristic(this.C.Model, 'Thermostat')
      .setCharacteristic(this.C.SerialNumber, 'Unknown');

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

    this.ecoService.getCharacteristic(this.C.On)
      .onGet(this.handleEcoSwitchGet.bind(this))
      .onSet(this.handleEcoSwitchSet.bind(this));
  }

  async handleCurrentHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();
    const status = characteristics.getHvacStatus();
    if (status === 'HEATING') {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    } else if (status === 'COOLING') {
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    } else {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();
    const targetMode = characteristics.getTargetMode();
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
    const characteristics = await this.api.fetch();

    if (characteristics.getEcoMode() === 'MANUAL_ECO') {
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
    if (!characteristics.getAvailableTargetModes().includes(mode)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }

    await this.api.executeCommand('sdm.devices.commands.ThermostatMode.SetMode', {
      mode,
    });
  }

  async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();
    return characteristics.getCurrentTemperature();
  }

  async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();

    const setpoint = characteristics.getTemperatureSetpoint();
    const heat = setpoint['heatCelsius'];
    const cool = setpoint['coolCelsius'];

    if (heat && !cool) {
      return heat;
    } else if (!heat && cool) {
      return cool;
    } else {
      return characteristics.getCurrentTemperature();
    }
  }

  async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TargetTemperature:', value);
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
  }

  async handleTemperatureDisplayUnitsGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();

    const displayUnit = characteristics.getDisplayUnit();
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
    const characteristics = await this.api.fetch();

    const setpoint = characteristics.getTemperatureSetpoint();
    if (!setpoint.coolCelsius) {
      return setpoint.heatCelsius!;
    }

    return setpoint.coolCelsius;
  }

  async handleCoolingThresholdTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET CoolingThresholdTemperature:', value);
    const characteristics = await this.api.fetch();

    if (characteristics.getEcoMode() === 'MANUAL_ECO') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    const mode = characteristics.getTargetMode();
    if (mode !== 'COOL' && mode !== 'HEATCOOL') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    if (mode === 'COOL') {
      await this.api.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', {
        coolCelsius: value,
      });
    } else {
      await this.api.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange', {
        heatCelsius: characteristics.getTemperatureSetpoint().heatCelsius,
        coolCelsius: value,
      });
    }
  }

  async handleHeatingThresholdTemperatureGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();

    const setpoint = characteristics.getTemperatureSetpoint();
    if (!setpoint.heatCelsius) {
      return setpoint.coolCelsius!;
    }

    return setpoint.heatCelsius;
  }

  async handleHeatingThresholdTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET HeatingThresholdTemperature:', value);
    const characteristics = await this.api.fetch();

    if (characteristics.getEcoMode() === 'MANUAL_ECO') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    const mode = characteristics.getTargetMode();
    if (mode !== 'HEAT' && mode !== 'HEATCOOL') {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    if (mode === 'HEAT') {
      await this.api.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat', {
        heatCelsius: value,
      });
    } else {
      await this.api.executeCommand('sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange', {
        heatCelsius: value,
        coolCelsius: characteristics.getTemperatureSetpoint().coolCelsius,
      });
    }
  }

  async handleEcoSwitchGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();
    return characteristics.getEcoMode() === 'MANUAL_ECO';
  }

  async handleEcoSwitchSet(value: CharacteristicValue) {
    this.log.info('Triggered SET EchoSwtich:', value);
    await this.api.executeCommand('sdm.devices.commands.ThermostatEco.SetMode', {
      mode: value ? 'MANUAL_ECO' : 'OFF',
    });
  }

  async handleCurrentRelativeHumidityGet(): Promise<CharacteristicValue> {
    const characteristics = await this.api.fetch();
    return characteristics.getRelativeHumidity();
  }

  async handleNameGet(): Promise<CharacteristicValue> {
    return 'Google Nest Thermostat';
  }
}
