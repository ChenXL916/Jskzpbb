import { Controller, Sse } from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '@jishi/contracts';
import { CurrentUser } from '../common/auth.decorators';
import { RealtimeService } from './realtime.service';

@Controller('events')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse()
  stream(@CurrentUser() user: CurrentUserType) {
    return this.realtime.streamFor(user);
  }
}
