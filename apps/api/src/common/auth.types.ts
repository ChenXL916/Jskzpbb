import { CurrentUser } from '@jishi/contracts';
import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: CurrentUser;
}
