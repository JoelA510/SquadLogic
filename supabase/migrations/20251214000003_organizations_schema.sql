-- Create organizations table
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    contact_info JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Add organization_id to season_settings
ALTER TABLE season_settings
ADD COLUMN organization_id UUID REFERENCES organizations(id);

-- Create index for organization_id
CREATE INDEX idx_season_settings_organization_id ON season_settings(organization_id);

-- Trigger for updated_at
CREATE TRIGGER update_organizations_modtime
    BEFORE UPDATE ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp();

-- RLS Policies (Provisional)

-- Admins can do everything
CREATE POLICY "Admins can manage organizations"
    ON organizations
    FOR ALL
    TO authenticated
    USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- Users can view their own organization (placeholder logic until user-org linking is solidified)
-- For now, we allow authenticated users to read organizations if they are linked to it via some future mechanism.
-- Currently, just restrict to admins or open up if needed. Keeping strictly admin for now as per Refactor.md "centralized approach".
