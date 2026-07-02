import { Entity, PrimaryColumn, Column } from "typeorm"

@Entity("users")
export class Users {
  @PrimaryColumn({
    type: "uuid"
  })
  id: string;

  @Column({
    length: 255
  })
  email: string;

  @Column({
    type: "uuid",
    name: "session_token",
    nullable: true
  })
  sessionToken: string | null;
}