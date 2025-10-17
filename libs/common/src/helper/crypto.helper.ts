import { InternalServerErrorException } from '@nestjs/common';
import * as crypto from 'crypto';
import { privateKey, publicKey } from '../key/private-and-public.key';

export async function encrypt(data: string): Promise<string> {
  try {
    const encryptedData = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(data, 'utf8'),
    );
    return encryptedData.toString('base64');
  } catch (error) {
    throw new InternalServerErrorException({
      message: 'Failed to encrypt data. Ensure data size is within RSA limits.',
      error: error.message,
    });
  }
}

export async function decrypt(data: string): Promise<string> {
  try {
    const bufferData = Buffer.from(data, 'base64');
    const decryptedData = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      bufferData,
    );
    return decryptedData.toString('utf8');
  } catch (error) {
    console.log(error);
    throw new InternalServerErrorException({
      message: 'Failed to decrypt data. Ensure encrypted data is valid.',
      error: error.message,
    });
  }
}
