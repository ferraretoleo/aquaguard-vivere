-- Mensalidades do AquaGuard, exclusivas do Administrador Geral.
CREATE TABLE IF NOT EXISTS user_subscriptions (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 plan varchar(20) NOT NULL CHECK (plan IN ('PISCINA','CONDOMINIO','PROFISSIONAL','EMPRESA')),
 monthly_amount numeric(12,2) NOT NULL CHECK (monthly_amount >= 0),
 due_day smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscription_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 competence date NOT NULL CHECK (extract(day FROM competence)=1),
 paid_on date NOT NULL,
 amount numeric(12,2) NOT NULL CHECK (amount > 0),
 notes text NOT NULL DEFAULT '',
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,competence)
);
