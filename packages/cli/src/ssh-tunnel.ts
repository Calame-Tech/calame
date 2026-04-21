import { Client } from 'ssh2';
import net from 'net';

export interface SshTunnelConfig {
  host: string;
  port: number; // default 22
  username: string;
  privateKey?: string; // PEM string
  password?: string;
  dbHost: string; // DB host as seen from bastion
  dbPort: number; // DB port as seen from bastion
}

export interface SshTunnel {
  localPort: number;
  close: () => Promise<void>;
}

export async function createSshTunnel(config: SshTunnelConfig): Promise<SshTunnel> {
  return new Promise((resolve, reject) => {
    const sshClient = new Client();

    sshClient.on('ready', () => {
      // Create a local TCP server that forwards to the remote DB through SSH
      const server = net.createServer((sock) => {
        sshClient.forwardOut(
          sock.remoteAddress ?? '127.0.0.1',
          sock.remotePort ?? 0,
          config.dbHost,
          config.dbPort,
          (err, stream) => {
            if (err) {
              sock.end();
              return;
            }
            sock.pipe(stream).pipe(sock);
          },
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve({
          localPort: addr.port,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => {
                sshClient.end();
                res();
              });
            }),
        });
      });

      server.on('error', (err) => reject(err));
    });

    sshClient.on('error', (err) => reject(err));

    const connectConfig: Record<string, unknown> = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
    };
    if (config.privateKey) connectConfig.privateKey = config.privateKey;
    if (config.password) connectConfig.password = config.password;

    sshClient.connect(connectConfig as Parameters<typeof sshClient.connect>[0]);
  });
}
