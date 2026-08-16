import { Response } from 'express';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export const sendSuccess = <T>(res: Response, data: T, statusCode = 200): Response => {
  const payload: ApiResponse<T> = {
    success: true,
    data,
    error: null,
  };
  return res.status(statusCode).json(payload);
};

export const sendError = (
  res: Response,
  message: string,
  statusCode = 400
): Response => {
  const payload: ApiResponse = {
    success: false,
    data: null,
    error: message,
  };
  return res.status(statusCode).json(payload);
};
