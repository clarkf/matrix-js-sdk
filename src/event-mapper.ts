/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { MatrixClient } from "./client";
import { IEvent, MatrixEvent, MatrixEventEvent } from "./models/event";

export type EventMapper = (obj: Partial<IEvent>) => MatrixEvent;

export interface MapperOpts {
    // don't re-emit events emitted on an event mapped by this mapper on the client
    preventReEmit?: boolean;
    // decrypt event proactively
    decrypt?: boolean;
    // the event is a to_device event
    toDevice?: boolean;
}

export function eventMapperFor(client: MatrixClient, options: MapperOpts): EventMapper {
    let preventReEmit = Boolean(options.preventReEmit);
    const decrypt = options.decrypt !== false;

    function mapper(plainOldJsObject: Partial<IEvent>): MatrixEvent {
        if (options.toDevice) {
            delete plainOldJsObject.room_id;
        }

        const room = client.getRoom(plainOldJsObject.room_id);

        let event: MatrixEvent | undefined;
        // If the event is already known to the room, let's re-use the model rather than duplicating.
        // We avoid doing this to state events as they may be forward or backwards looking which tweaks behaviour.
        if (room && plainOldJsObject.state_key === undefined) {
            event = room.findEventById(plainOldJsObject.event_id!);
        }

        if (!event || event.status) {
            event = new MatrixEvent(plainOldJsObject);
        } else {
            // merge the latest unsigned data from the server
            event.setUnsigned({ ...event.getUnsigned(), ...plainOldJsObject.unsigned });
            // prevent doubling up re-emitters
            preventReEmit = true;
        }

        const thread = room?.findThreadForEvent(event);
        if (thread) {
            event.setThread(thread);
        }

        // TODO: once we get rid of the old libolm-backed crypto, we can restrict this to room events (rather than
        //   to-device events), because the rust implementation decrypts to-device messages at a higher level.
        //   Generally we probably want to use a different eventMapper implementation for to-device events because
        if (event.isEncrypted()) {
            if (!preventReEmit) {
                client.reEmitter.reEmit(event, [MatrixEventEvent.Decrypted]);
            }
            if (decrypt) {
                client.decryptEventIfNeeded(event);
            }
        }

        if (!preventReEmit) {
            client.reEmitter.reEmit(event, [MatrixEventEvent.Replaced, MatrixEventEvent.VisibilityChange]);
            room?.reEmitter.reEmit(event, [MatrixEventEvent.BeforeRedaction]);
        }
        return event;
    }

    return mapper;
}
