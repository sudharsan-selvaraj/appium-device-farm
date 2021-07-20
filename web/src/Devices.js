import Device from './Device';
import DeviceDetailsDialog from './DeviceDetailsDialog';
import { useState } from 'react';

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const Devices = ({ devices, platform }) => {
  const [showDeviceDetailsDialog, setShowDeviceDetailsDialog] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState({});

  return (
    <>
      <section className="grid-container">
        {devices
          .filter((device) => {
            if (platform.toLowerCase() === 'android' || platform === 'iOS')
              return device.platform.toLowerCase() === platform.toLowerCase();
            return device;
          })
          .map((device) => (
            <>
              <Device
                device={device}
                setSelectedDevice={setSelectedDevice}
                setShowDeviceDetailsDialog={setShowDeviceDetailsDialog}
              />
            </>
          ))}
      </section>
      <DeviceDetailsDialog
        show={showDeviceDetailsDialog}
        selectedDevice={selectedDevice}
        onHide={() => setShowDeviceDetailsDialog(false)}
      />
    </>
  );
};
export default Devices;
